/**
 * FileRegistry V2 Contract Integration
 * Handles server-side blockchain transactions for gasless file metadata storage
 */

import { ethers } from 'ethers';

// FileRegistry V2 Contract ABI (only functions we need)
const FILE_REGISTRY_ABI = [
  // addFile - Server calls this on behalf of user
  'function addFile(address _owner, bytes32 _rootHash, string _encryptionSalt, string _encryptionIv, string _filename, uint256 _size, uint256 _encryptedSize, string _mimeType, uint256 _chainId) external',

  // View functions
  'function getUserFiles(address _user) external view returns (tuple(bytes32 rootHash, string encryptionSalt, string encryptionIv, string filename, uint256 size, uint256 encryptedSize, string mimeType, uint256 timestamp, uint256 chainId, bool deleted)[] memory)',
  'function getActiveUserFiles(address _user) external view returns (tuple(bytes32 rootHash, string encryptionSalt, string encryptionIv, string filename, uint256 size, uint256 encryptedSize, string mimeType, uint256 timestamp, uint256 chainId, bool deleted)[] memory)',
  'function getFileByRootHash(bytes32 _rootHash) external view returns (tuple(bytes32 rootHash, string encryptionSalt, string encryptionIv, string filename, uint256 size, uint256 encryptedSize, string mimeType, uint256 timestamp, uint256 chainId, bool deleted) memory)',

  // Admin functions
  'function trustedSigner() external view returns (address)',
];

export interface FileMetadata {
  owner: string;
  rootHash: string;
  encryptionSalt: string;
  encryptionIv: string;
  filename: string;
  size: number;
  encryptedSize: number;
  mimeType: string;
  chainId: number;
}

export class FileRegistryClient {
  private contract: ethers.Contract;
  private signer: ethers.Wallet;
  private chainId: number;

  constructor(
    contractAddress: string,
    signer: ethers.Wallet,
    chainId: number = 16602 // 0G Newton Testnet
  ) {
    this.contract = new ethers.Contract(contractAddress, FILE_REGISTRY_ABI, signer);
    this.signer = signer;
    this.chainId = chainId;
  }

  /**
   * Add file metadata to the registry (gasless - server pays gas)
   * @param metadata File metadata including owner address
   * @returns Transaction hash
   */
  async addFile(metadata: FileMetadata): Promise<string> {
    try {
      console.log(`[FileRegistry] Adding file for owner: ${metadata.owner}`);
      console.log(`[FileRegistry] Root hash: ${metadata.rootHash}`);
      console.log(`[FileRegistry] Filename: ${metadata.filename}`);

      // Convert root hash to bytes32 format (remove 0x and pad to 66 chars)
      const rootHashBytes32 = metadata.rootHash.startsWith('0x')
        ? metadata.rootHash
        : '0x' + metadata.rootHash;

      // Call contract's addFile function
      // Server wallet signs and pays gas, but owner is recorded as the user
      const tx = await this.contract.addFile(
        metadata.owner,              // User's wallet address
        rootHashBytes32,             // Root hash from 0G upload
        metadata.encryptionSalt,     // Encryption salt
        metadata.encryptionIv,       // Encryption IV
        metadata.filename,           // Original filename
        metadata.size,               // Original file size
        metadata.encryptedSize,      // Encrypted file size
        metadata.mimeType,           // MIME type
        this.chainId                 // Chain ID
      );

      console.log(`[FileRegistry] Transaction sent: ${tx.hash}`);
      console.log(`[FileRegistry] Waiting for confirmation...`);

      // Wait for transaction to be mined
      const receipt = await tx.wait();

      console.log(`[FileRegistry] Transaction confirmed in block ${receipt.blockNumber}`);
      console.log(`[FileRegistry] Gas used: ${receipt.gasUsed.toString()}`);

      return tx.hash;
    } catch (error) {
      console.error('[FileRegistry] Error adding file:', error);
      throw error;
    }
  }

  /**
   * Get all files for a user
   * @param userAddress User's wallet address
   * @returns Array of file metadata
   */
  async getUserFiles(userAddress: string) {
    try {
      console.log(`[FileRegistry] Fetching files for user: ${userAddress}`);
      const files = await this.contract.getUserFiles(userAddress);
      console.log(`[FileRegistry] Found ${files.length} files`);
      return files;
    } catch (error) {
      console.error('[FileRegistry] Error fetching user files:', error);
      throw error;
    }
  }

  /**
   * Get only active (non-deleted) files for a user
   * @param userAddress User's wallet address
   * @returns Array of active file metadata
   */
  async getActiveUserFiles(userAddress: string) {
    try {
      console.log(`[FileRegistry] Fetching active files for user: ${userAddress}`);
      const files = await this.contract.getActiveUserFiles(userAddress);
      console.log(`[FileRegistry] Found ${files.length} active files`);
      return files;
    } catch (error) {
      console.error('[FileRegistry] Error fetching active files:', error);
      throw error;
    }
  }

  /**
   * Get file metadata by root hash
   * @param rootHash 0G storage root hash
   * @returns File metadata
   */
  async getFileByRootHash(rootHash: string) {
    try {
      const rootHashBytes32 = rootHash.startsWith('0x') ? rootHash : '0x' + rootHash;
      console.log(`[FileRegistry] Fetching file by root hash: ${rootHashBytes32}`);
      const file = await this.contract.getFileByRootHash(rootHashBytes32);
      return file;
    } catch (error) {
      console.error('[FileRegistry] Error fetching file by root hash:', error);
      throw error;
    }
  }

  /**
   * Get the trusted signer address (server wallet)
   * @returns Trusted signer address
   */
  async getTrustedSigner(): Promise<string> {
    try {
      const trustedSigner = await this.contract.trustedSigner();
      console.log(`[FileRegistry] Trusted signer: ${trustedSigner}`);
      return trustedSigner;
    } catch (error) {
      console.error('[FileRegistry] Error getting trusted signer:', error);
      throw error;
    }
  }

  /**
   * Verify that the current signer is the trusted signer
   * @returns true if signer is trusted, false otherwise
   */
  async verifyTrustedSigner(): Promise<boolean> {
    try {
      const trustedSigner = await this.getTrustedSigner();
      const isTrusted = trustedSigner.toLowerCase() === this.signer.address.toLowerCase();

      if (!isTrusted) {
        console.warn(`[FileRegistry] WARNING: Current signer (${this.signer.address}) is NOT the trusted signer (${trustedSigner})`);
      } else {
        console.log(`[FileRegistry] ✓ Current signer is the trusted signer`);
      }

      return isTrusted;
    } catch (error) {
      console.error('[FileRegistry] Error verifying trusted signer:', error);
      return false;
    }
  }
}
