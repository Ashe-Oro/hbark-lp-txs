// fetchTradersWithTwitter.js

const axios = require('axios');
const chalk = require('chalk'); // For color coding output
const { Interface, keccak256, toUtf8Bytes } = require('ethers');

// Load ABI for the Swap event
const abi = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "internalType": "address", "name": "sender",    "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amount0In",  "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount1In",  "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount0Out", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount1Out", "type": "uint256" },
      { "indexed": true,  "internalType": "address", "name": "to",        "type": "address" }
    ],
    "name": "Swap",
    "type": "event"
  }
];

const abiInterface = new Interface(abi);
const swapEventSignature = keccak256(toUtf8Bytes("Swap(address,uint256,uint256,uint256,uint256,address)"));

// Mirror Node API base URL and contract address
const mirrorNodeBaseUrl = 'https://mainnet-public.mirrornode.hedera.com';
const contractAddress = '0x6c241d9dea13214b43d198585ce214caf4d346df'; // Replace with your contract address if different
const url = `${mirrorNodeBaseUrl}/api/v1/contracts/${contractAddress}/results/logs?limit=100`;

// Local mappings
const tokenMetadata = {
  '0x00000000000000000000000000000000004ca367': { symbol: 'HBARK', decimals: 0 },
  'HBAR': { symbol: 'HBAR', decimals: 8 } // Assuming HBAR has 8 decimals
};

const pairTokenMapping = {
  '0x6c241d9dea13214b43d198585ce214caf4d346df': {
    token0: 'HBAR',
    token1: '0x00000000000000000000000000000000004ca367',
  }
};

// Swap contract address in Hedera account ID format
const swapContractAccountId = '0.0.3045981';

// Caches for minimizing API requests
const twitterHandleCache = {};
const accountIdCache = {};

/**
 * Converts a "long zero" EVM address to Hedera account ID.
 * Example: '0x00000000000000000000000000000000002e7a5d' => '0.0.2'
 * @param {string} evmAddress - The EVM address.
 * @returns {string|null} - The Hedera account ID or null if not applicable.
 */
function evmAddressToAccountId(evmAddress) {
  const addressLower = evmAddress.toLowerCase();
  const longZeroPrefix = '0x000000000000000000000000';
  if (addressLower.startsWith(longZeroPrefix)) {
    const accountIdHex = addressLower.slice(longZeroPrefix.length);
    // Handle potential leading zeros and ensure correct parsing
    const accountIdDecimal = parseInt(accountIdHex, 16);
    if (!isNaN(accountIdDecimal)) {
      return `0.0.${accountIdDecimal}`;
    }
  }
  // Return null to indicate that it's not a long-zero address
  return null;
}

/**
 * Fetches the Hedera account ID from the EVM address.
 * First attempts to convert "long zero" addresses.
 * If unsuccessful, fetches from the Mirror Node API.
 * @param {string} address - The EVM address.
 * @returns {string} - The Hedera account ID or the original address if not found.
 */
async function getAccountIdFromAddress(address) {
  if (accountIdCache[address]) {
    return accountIdCache[address];
  }

  // First, attempt to convert using evmAddressToAccountId
  const convertedAccountId = evmAddressToAccountId(address);
  if (convertedAccountId) {
    accountIdCache[address] = convertedAccountId;
    return convertedAccountId;
  }

  // If not a long-zero address, fetch from the Mirror Node API
  const accountUrl = `${mirrorNodeBaseUrl}/api/v1/accounts/${address}`;
  try {
    const response = await axios.get(accountUrl);
    if (response.status === 200 && response.data && response.data.account) {
      const fetchedAccountId = response.data.account;
      accountIdCache[address] = fetchedAccountId;
      return fetchedAccountId;
    }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // No account found for this EVM address
      console.error(`No Hedera account found for EVM address ${address}.`);
    } else {
      console.error(`Error fetching account ID for address ${address}:`, error.message);
    }
  }

  // If unable to get account ID, return the original address
  return address;
}

/**
 * Fetches the Twitter handle associated with a Hedera account ID.
 * @param {string} accountId - The Hedera account ID.
 * @returns {string|null} - The Twitter handle or null if not found.
 */
async function fetchTwitterHandle(accountId) {
  if (twitterHandleCache[accountId] !== undefined) {
    return twitterHandleCache[accountId];
  }

  const twitterApiUrl = `https://sure-angeline-piotrswierzy-b061c303.koyeb.app/users/${accountId}`;
  try {
    const response = await axios.get(twitterApiUrl);
    if (response.status === 200 && response.data && response.data.twitterHandle) {
      twitterHandleCache[accountId] = response.data.twitterHandle;
      return response.data.twitterHandle;
    }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // No Twitter handle associated with this account ID
      twitterHandleCache[accountId] = null;
    } else {
      console.error(`Error fetching Twitter handle for account ${accountId}:`, error.message);
    }
  }

  return null;
}

/**
 * Fetches logs from the Mirror Node API.
 * @returns {Array} - An array of log objects.
 */
async function fetchLogsFromMirrorNode() {
  try {
    const response = await axios.get(url);
    if (response.status === 200 && response.data && response.data.logs) {
      return response.data.logs;
    } else {
      console.error('Error fetching logs from Mirror Node API: Invalid response structure.');
      return [];
    }
  } catch (error) {
    console.error('Error fetching logs from Mirror Node API:', error.message);
    return [];
  }
}

/**
 * Processes the fetched logs to identify BUY and SELL transactions.
 * Fetches Twitter handles for senders and recipients when available.
 * @param {Array} logs - The array of log objects.
 */
async function processLogs(logs) {
  for (const log of logs) {
    // Check if the log corresponds to the Swap event
    if (log.topics[0].toLowerCase() !== swapEventSignature.toLowerCase()) {
      continue;
    }

    let parsedLog;
    try {
      parsedLog = abiInterface.parseLog({ topics: log.topics, data: log.data });
    } catch (error) {
      console.error(`  Error parsing log:`, error.message);
      continue;
    }

    if (parsedLog && parsedLog.args) {
      const result = parsedLog.args;

      let amountIn, amountOut, tokenIn, tokenOut;

      if (result.amount0In === 0n) {
        amountIn = result.amount1In;
        amountOut = result.amount0Out;
        tokenIn = 'token1';
        tokenOut = 'token0';
      } else {
        amountIn = result.amount0In;
        amountOut = result.amount1Out;
        tokenIn = 'token0';
        tokenOut = 'token1';
      }

      // Get token addresses from pair mapping
      const tokens = pairTokenMapping[log.address.toLowerCase()];
      if (!tokens) {
        console.error(`  Pair address ${log.address.toLowerCase()} not found in pairTokenMapping.`);
        continue;
      }

      const tokenInMetadata = tokenMetadata[tokens[tokenIn]];
      const tokenOutMetadata = tokenMetadata[tokens[tokenOut]];

      if (!tokenInMetadata || !tokenOutMetadata) {
        console.error(`  Token metadata not found for tokens in pair ${log.address.toLowerCase()}.`);
        continue;
      }

      // Adjust amounts based on decimals
      const adjustedAmountIn = Number(amountIn) / (10 ** tokenInMetadata.decimals);
      const adjustedAmountOut = Number(amountOut) / (10 ** tokenOutMetadata.decimals);

      // Convert timestamp to human-readable format
      const timestampSeconds = parseFloat(log.timestamp);
      const date = new Date(timestampSeconds * 1000);
      const formattedDate = date.toISOString().replace('T', ' ').split('.')[0];

      // Extract sender and to addresses and get account IDs
      const senderAddress = result.sender;
      const toAddress = result.to;

      const senderAccountId = await getAccountIdFromAddress(senderAddress);
      const toAccountId = await getAccountIdFromAddress(toAddress);

      // Fetch Twitter handles if account IDs are in the format '0.0.xxxxx'
      let senderTwitterHandle = null;
      if (/^0\.0\.\d+$/.test(senderAccountId)) {
        senderTwitterHandle = await fetchTwitterHandle(senderAccountId);
      }

      let toTwitterHandle = null;
      if (/^0\.0\.\d+$/.test(toAccountId)) {
        toTwitterHandle = await fetchTwitterHandle(toAccountId);
      }

      // Determine if transaction is a BUY or SELL
      let transactionType;
      if (tokenInMetadata.symbol === 'HBAR') {
        transactionType = 'BUY';
      } else if (tokenInMetadata.symbol === 'HBARK') {
        transactionType = 'SELL';
      } else {
        transactionType = 'UNKNOWN';
      }

      // Color code the output
      let coloredOutput;
      if (transactionType === 'BUY') {
        coloredOutput = chalk.green(transactionType);
      } else if (transactionType === 'SELL') {
        coloredOutput = chalk.yellow(transactionType);
      } else {
        coloredOutput = transactionType;
      }

      // Construct the output string
      let output = '';
      output += `${coloredOutput}`;
      output += ` | timestamp: ${formattedDate}`;
      output += ` | sender: ${senderAccountId}`;
      if (senderTwitterHandle) {
        output += ` (@${senderTwitterHandle})`;
      }
      output += ` | to: ${toAccountId}`;
      if (toTwitterHandle) {
        output += ` (@${toTwitterHandle})`;
      }
      output += ` | amountIn: ${adjustedAmountIn} ${tokenInMetadata.symbol}`;
      output += ` | amountOut: ${adjustedAmountOut} ${tokenOutMetadata.symbol}`;

      console.log(output);
    } else {
      console.error(`  Parsed log is null or missing arguments.`);
    }
  }
}

/**
 * Main function to fetch and process logs.
 */
async function fetchAndProcessLogs() {
  const logs = await fetchLogsFromMirrorNode();

  if (logs.length === 0) {
    console.log("No logs to process.");
    return;
  }

  await processLogs(logs);
}

// Execute the main function
fetchAndProcessLogs();
