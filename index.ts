import 'dotenv/config';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { ethers } from 'ethers';
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { FileRegistryClient } from './fileRegistry.js';

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

// Configuration from environment variables
const CONFIG = {
  evmRpc: process.env.ZG_BLOCKCHAIN_RPC || 'https://evmrpc-testnet.0g.ai',
  indexerRpc: process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai',
  privateKey: process.env.ZG_PRIVATE_KEY || '',
  fileRegistryContract: process.env.FILE_REGISTRY_CONTRACT || '',
  port: parseInt(process.env.PORT || process.env.ZG_SERVICE_PORT || '3001'),
};

// Validate private key
if (!CONFIG.privateKey || CONFIG.privateKey === '0xYourPrivateKeyHere') {
  console.error('❌ ERROR: ZG_PRIVATE_KEY not configured in .env');
  console.error('');
  console.error('Please set a valid Ethereum private key in your .env file:');
  console.error('  ZG_PRIVATE_KEY=0xYourPrivateKeyHere');
  console.error('');
  console.error('Get testnet tokens: https://faucet.0g.ai');
  process.exit(1);
}

// Validate private key format (64 hex chars, optionally prefixed with 0x)
const keyPattern = /^(0x)?[0-9a-fA-F]{64}$/;
if (!keyPattern.test(CONFIG.privateKey)) {
  console.error('❌ ERROR: Invalid private key format');
  console.error('');
  console.error('Private key must be 64 hexadecimal characters (32 bytes)');
  console.error('');
  console.error('Valid formats:');
  console.error('  ZG_PRIVATE_KEY=0x1234...cdef (with 0x prefix)');
  console.error('  ZG_PRIVATE_KEY=1234...cdef (without 0x prefix)');
  console.error('');
  console.error('Current value starts with:', CONFIG.privateKey.substring(0, 10) + '...');
  process.exit(1);
}

// Initialize provider and signer
console.log('[0G Storage] Initializing service...');
console.log(`[0G Storage] RPC: ${CONFIG.evmRpc}`);
console.log(`[0G Storage] Indexer: ${CONFIG.indexerRpc}`);

const provider = new ethers.JsonRpcProvider(CONFIG.evmRpc);
const signer = new ethers.Wallet(CONFIG.privateKey, provider);
const indexer = new Indexer(CONFIG.indexerRpc);

console.log(`[0G Storage] Wallet address: ${signer.address}`);

// Initialize FileRegistry V2 client (gasless architecture)
let fileRegistry: FileRegistryClient | null = null;
if (CONFIG.fileRegistryContract) {
  try {
    fileRegistry = new FileRegistryClient(CONFIG.fileRegistryContract, signer);
    console.log(`[FileRegistry] Initialized with contract: ${CONFIG.fileRegistryContract}`);

    // Verify trusted signer
    await fileRegistry.verifyTrustedSigner();
  } catch (error) {
    console.error('[FileRegistry] Failed to initialize:', error);
    console.error('[FileRegistry] Gasless metadata storage will be disabled');
  }
} else {
  console.warn('[FileRegistry] No contract address configured. Gasless metadata storage disabled.');
}

// Middleware
app.use(express.json());

// CORS middleware - allow requests from frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // In production, restrict to specific origins
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-wallet-address, x-encryption-salt, x-encryption-iv');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '0g-storage' });
});

/**
 * Upload file to 0G Storage
 * POST /upload
 * Body: multipart/form-data with 'file' field
 * Optional: encrypted=true to indicate file is already encrypted
 */
app.post('/upload', upload.single('file'), async (req, res) => {
  let zgFile: ZgFile | null = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;
    const encrypted = req.body.encrypted === 'true';

    console.log(`[0G Upload] Starting upload for ${originalName} (${fileSize} bytes)`);

    // Warn about large files that may timeout
    if (fileSize > 5 * 1024 * 1024) { // 5MB
      console.warn(`[0G Upload] Warning: Large file (${fileSize} bytes) may exceed 30s timeout`);
    }

    // Create ZgFile from uploaded file
    zgFile = await ZgFile.fromFilePath(filePath);

    // Generate merkle tree
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr) {
      console.error('[0G Upload] Merkle tree error:', treeErr);
      return res.status(500).json({ error: 'Failed to generate merkle tree', details: treeErr });
    }

    if (!tree) {
      return res.status(500).json({ error: 'Merkle tree generation returned null' });
    }

    const rootHash = tree.rootHash();
    console.log(`[0G Upload] Merkle root hash: ${rootHash}`);

    // Upload to 0G network
    const [tx, uploadErr] = await indexer.upload(zgFile, CONFIG.evmRpc, signer);
    if (uploadErr) {
      console.error('[0G Upload] Upload error:', uploadErr);
      return res.status(500).json({ error: 'Failed to upload to 0G network', details: uploadErr });
    }

    // Get transaction hash (tx can be string or object)
    const txHash = typeof tx === 'string' ? tx : (tx as any)?.hash || null;
    console.log(`[0G Upload] Upload successful. TX: ${txHash || 'N/A'}`);

    // Register file metadata on-chain (gasless - server pays gas)
    let registryTxHash: string | null = null;
    if (fileRegistry) {
      try {
        // Get wallet address from headers (sent by frontend)
        const walletAddress = req.headers['x-wallet-address'] as string;

        if (walletAddress && ethers.isAddress(walletAddress)) {
          console.log(`[FileRegistry] Registering file for wallet: ${walletAddress}`);

          // Get encryption metadata from request body/headers
          const encryptionSalt = (req.body.encryptionSalt || req.headers['x-encryption-salt'] || '') as string;
          const encryptionIv = (req.body.encryptionIv || req.headers['x-encryption-iv'] || '') as string;

          // Register file on-chain
          registryTxHash = await fileRegistry.addFile({
            owner: walletAddress,
            rootHash: rootHash || '',
            encryptionSalt,
            encryptionIv,
            filename: originalName,
            size: req.file.size,
            encryptedSize: fileSize,
            mimeType: req.file.mimetype,
            chainId: 16602, // 0G Newton Testnet
          });

          console.log(`[FileRegistry] File registered on-chain. TX: ${registryTxHash}`);
        } else {
          console.warn('[FileRegistry] No valid wallet address provided. Skipping on-chain registration.');
        }
      } catch (registryError) {
        // Don't fail the entire upload if registry fails
        console.error('[FileRegistry] Failed to register file on-chain:', registryError);
        console.error('[FileRegistry] Upload successful but metadata not stored on-chain');
      }
    }

    // Clean up temp file
    await fs.unlink(filePath);

    // Return upload metadata
    res.json({
      success: true,
      rootHash,
      txHash,
      registryTxHash, // Include registry transaction hash
      filename: originalName,
      size: req.file.size,
      mimeType: req.file.mimetype,
      encrypted,
      uploadedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[0G Upload] Unexpected error:', error);
    res.status(500).json({
      error: 'Upload failed',
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // Close file handle
    if (zgFile) {
      try {
        await zgFile.close();
      } catch (closeErr) {
        console.error('[0G Upload] Error closing file:', closeErr);
      }
    }
  }
});

/**
 * Download file from 0G Storage
 * GET /download/:rootHash
 * Query params: filename (optional) - name to save file as
 */
app.get('/download/:rootHash', async (req, res) => {
  try {
    const { rootHash } = req.params;
    const filename = req.query.filename as string || `file_${rootHash.substring(0, 8)}`;

    if (!rootHash || rootHash.length < 10) {
      return res.status(400).json({ error: 'Invalid root hash' });
    }

    console.log(`[0G Download] Downloading file with root hash: ${rootHash}`);

    // Create temp output path
    const tempDir = '/tmp/downloads';
    await fs.mkdir(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `${crypto.randomBytes(16).toString('hex')}_${filename}`);

    // Download from 0G network
    const downloadErr = await indexer.download(rootHash, outputPath, true);
    if (downloadErr) {
      console.error('[0G Download] Download error:', downloadErr);
      return res.status(500).json({ error: 'Failed to download from 0G network', details: downloadErr });
    }

    console.log(`[0G Download] Download successful. Streaming to client...`);

    // Stream file to client
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = await fs.readFile(outputPath);
    res.send(fileStream);

    // Clean up temp file
    await fs.unlink(outputPath);
  } catch (error) {
    console.error('[0G Download] Unexpected error:', error);
    res.status(500).json({
      error: 'Download failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Check data availability status for a file
 * GET /status/:rootHash
 */
app.get('/status/:rootHash', async (req, res) => {
  try {
    const { rootHash } = req.params;

    if (!rootHash || rootHash.length < 10) {
      return res.status(400).json({ error: 'Invalid root hash' });
    }

    // Note: The SDK doesn't expose a direct status check method in the docs
    // This is a placeholder for when that functionality is available
    // For now, we attempt a download to verify availability

    console.log(`[0G Status] Checking status for root hash: ${rootHash}`);

    // Try to get file info (this may not be available in current SDK version)
    // As a workaround, we return a basic status
    res.json({
      rootHash,
      available: true, // Would need SDK support to check actual status
      message: 'Status check requires SDK enhancement. File existence can be verified via download attempt.',
    });
  } catch (error) {
    console.error('[0G Status] Error checking status:', error);
    res.status(500).json({
      error: 'Status check failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get storage quota/usage (placeholder for future implementation)
 * GET /quota
 */
app.get('/quota', async (req, res) => {
  try {
    // This would require additional implementation to track user storage
    // For now, return a basic structure
    res.json({
      used: 0,
      limit: 1073741824, // 1GB in bytes
      unit: 'bytes',
      message: 'Quota tracking requires additional database integration',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Quota check failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Start server
app.listen(CONFIG.port, () => {
  console.log(`[0G Storage Service] Running on port ${CONFIG.port}`);
  console.log(`[0G Storage Service] EVM RPC: ${CONFIG.evmRpc}`);
  console.log(`[0G Storage Service] Indexer RPC: ${CONFIG.indexerRpc}`);
  console.log(`[0G Storage Service] Private key configured: ${CONFIG.privateKey ? 'Yes' : 'No (WARNING!)'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[0G Storage Service] Shutting down gracefully...');
  process.exit(0);
});
