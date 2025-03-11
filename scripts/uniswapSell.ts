import { config } from 'dotenv';
import { createPublicClient, http, createWalletClient, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const PRIVATE_KEYS = process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(',') : [];
const RPC_URL = process.env.RPC_URL!;
const UNISWAP_V2_ROUTER_ADDRESS = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' as const;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as const;
const GAS_LIMIT = 500000; // Adjust this value as needed

type EthereumAddress = `0x${string}`;

let bot: TelegramBot | null = null;

const client = createPublicClient({ transport: http(RPC_URL), chain: base });
const walletClients = PRIVATE_KEYS.map(key => createWalletClient({ transport: http(RPC_URL), chain: base, account: privateKeyToAccount(key as `0x${string}`) }));

const routerAbi = parseAbi([
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)'
]);

const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function name() view returns (string)'
]);

const log = console.log;
const createTxHashLink = (txHash: string) => `[${txHash}](https://basescan.org/tx/${txHash})`;

async function initializeBot() {
  if (bot) return;
  
  try {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    const commands = [
      { command: 'sell', description: 'Sell a percentage of tokens' },
      { command: 'sellall', description: 'Sell all tokens' },
      { command: 'balance', description: 'Check token balance' }
    ];

    await bot.setMyCommands(commands);

    bot.onText(/^\/balance(@\w+)?$/, msg => startOperation(signal => balanceProcess(msg.chat.id, msg.from!.id, msg.from!.username, signal)));
    bot.onText(/^\/sell(@\w+)?$/, msg => startOperation(signal => sellProcess(msg.chat.id, msg.from!.id, msg.from!.username, signal, false)));
    bot.onText(/^\/sellall(@\w+)?$/, msg => startOperation(signal => sellProcess(msg.chat.id, msg.from!.id, msg.from!.username, signal, true)));

    log('Bot initialized and running...');
  } catch (error) {
    log('Error initializing bot:', error);
    throw error;
  }
}

let currentOperation: { abort: () => void } | null = null;

function startOperation(operation: (signal: AbortSignal) => Promise<void>): void {
  if (currentOperation) {
    currentOperation.abort();
  }

  const abortController = new AbortController();
  currentOperation = {
    abort: () => {
      abortController.abort();
      currentOperation = null;
    }
  };

  operation(abortController.signal).catch(error => {
    if (error instanceof Error && error.message !== "AbortError" && error.message !== "Operation cancelled due to new command") {
      log('Operation error:', error);
    }
  }).finally(() => {
    currentOperation = null;
  });
}

function toEthereumAddress(address: string): EthereumAddress | null {
  return /^0x[a-f0-9]{40}$/i.test(address) ? address.toLowerCase() as EthereumAddress : null;
}

function isValidPercentage(percentage: number): boolean {
  return !isNaN(percentage) && percentage > 0 && percentage <= 100;
}

async function sellProcess(chatId: number, userId: number, username: string | undefined, signal: AbortSignal, sellAll: boolean): Promise<void> {
  try {
    const tokenAddress = await askForTokenAddress(chatId, userId, username, signal);
    if (signal.aborted) return;

    const balanceInfo = await getTokenBalanceInfo(tokenAddress);
    bot?.sendMessage(chatId, `@${username || userId}, Current holdings:\n${balanceInfo}`);

    let percentageToSell: number;
    if (sellAll) {
      const confirmed = await askForConfirmation(chatId, userId, username, signal);
      if (signal.aborted) return;
      if (!confirmed) {
        bot?.sendMessage(chatId, `@${username || userId}, Sell all operation cancelled.`);
        return;
      }
      percentageToSell = 100;
    } else {
      percentageToSell = await askForPercentage(chatId, userId, username, signal);
      if (signal.aborted) return;
    }

    await sellTokensForAllWallets(tokenAddress, percentageToSell, chatId, userId, username);
  } catch (error: unknown) {
    if (!signal.aborted && error instanceof Error) {
      log('Error in sellProcess:', error.message);
      bot?.sendMessage(chatId, `@${username || userId}, An error occurred: ${error.message}`);
    }
  }
}

async function askForConfirmation(chatId: number, userId: number, username: string | undefined, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let promptMessage: TelegramBot.Message | undefined;
    let timeoutId: NodeJS.Timeout;

    bot?.sendMessage(chatId, 'Are you sure you want to sell all tokens? Reply with "yes" or "no":', {
      reply_markup: {
        keyboard: [[{ text: 'yes' }], [{ text: 'no' }]],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    }).then(sent => promptMessage = sent);

    const messageHandler = (msg: TelegramBot.Message) => {
      if (signal.aborted) {
        cleanup();
        reject(new Error("Operation cancelled"));
        return;
      }

      if (msg.text?.toLowerCase() === 'yes') {
        cleanup();
        resolve(true);
      } else if (msg.text?.toLowerCase() === 'no') {
        cleanup();
        resolve(false);
      } else {
        bot?.sendMessage(chatId, "Please reply with 'yes' or 'no'.");
      }
    };

    const cleanup = () => {
      bot?.removeListener('message', messageHandler);
      if (promptMessage) bot?.deleteMessage(chatId, promptMessage.message_id).catch(() => {});
      if (timeoutId) clearTimeout(timeoutId);
      bot?.sendMessage(chatId, 'Confirmation received', {
        reply_markup: {
          remove_keyboard: true
        }
      });
    };

    bot?.on('message', messageHandler);

    });
  };

async function balanceProcess(chatId: number, userId: number, username: string | undefined, signal: AbortSignal): Promise<void> {
  try {
    const tokenAddress = await askForTokenAddress(chatId, userId, username, signal);
    if (signal.aborted) return;

    const balanceInfo = await getTokenBalanceInfo(tokenAddress);
    if (!signal.aborted) {
      bot?.sendMessage(chatId, `@${username || userId}, ${balanceInfo}`);
    }
  } catch (error: unknown) {
    if (!signal.aborted && error instanceof Error) {
      log('Error in balanceProcess:', error.message);
      bot?.sendMessage(chatId, `@${username || userId}, An error occurred: ${error.message}`);
    }
  }
}

async function askForTokenAddress(chatId: number, userId: number, username: string | undefined, signal: AbortSignal): Promise<EthereumAddress> {
  return new Promise((resolve, reject) => {
    let promptMessage: TelegramBot.Message | undefined;
    let timeoutId: NodeJS.Timeout;
    
    bot?.sendMessage(chatId, 'Please provide the token address:').then(sent => promptMessage = sent);

    const messageHandler = (msg: TelegramBot.Message) => {
      if (signal.aborted) {
        cleanup();
        reject(new Error("Operation cancelled"));
        return;
      }

      if (msg.text?.startsWith('/')) {
        cleanup();
        reject(new Error("Operation cancelled due to new command"));
        return;
      }

      const tokenAddress = toEthereumAddress(msg.text || '');
      
      if (tokenAddress) {
        cleanup();
        resolve(tokenAddress);
      } else {
        bot?.sendMessage(chatId, "Invalid Ethereum address format. Please try again with a valid address (0x followed by 40 hexadecimal characters).");
      }
    };

    const cleanup = () => {
      bot?.removeListener('message', messageHandler);
      if (promptMessage) bot?.deleteMessage(chatId, promptMessage.message_id).catch(() => {});
      if (timeoutId) clearTimeout(timeoutId);
    };

    bot?.on('message', messageHandler);
    });
  };

async function askForPercentage(chatId: number, userId: number, username: string | undefined, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let promptMessage: TelegramBot.Message | undefined;
    let timeoutId: NodeJS.Timeout;

    bot?.sendMessage(chatId, 'Please provide the percentage of the total supply you want to sell:').then(sent => promptMessage = sent);

    const messageHandler = (msg: TelegramBot.Message) => {
      if (signal.aborted || msg.text?.startsWith('/')) {
        cleanup();
        reject(new Error(signal.aborted ? "Operation cancelled" : "Operation cancelled due to new command"));
        return;
      }

      const percentage = parseFloat(msg.text!);
      
      if (isValidPercentage(percentage)) {
        cleanup();
        resolve(percentage);
      } else {
        bot?.sendMessage(chatId, "Invalid percentage. Please enter a number between 0 and 100.");
      }
    };

    const cleanup = () => {
      bot?.removeListener('message', messageHandler);
      if (promptMessage) bot?.deleteMessage(chatId, promptMessage.message_id).catch(() => {});
      if (timeoutId) clearTimeout(timeoutId);
    };

    bot?.on('message', messageHandler);

  });
}

async function getBalance(tokenAddress: EthereumAddress, accountAddress: EthereumAddress): Promise<bigint> {
  return client.readContract({
    address: tokenAddress,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [accountAddress]
  });
}

async function getTokenBalanceInfo(tokenAddress: EthereumAddress): Promise<string> {
  const totalSupply = BigInt(1_000_000_000) * BigInt(10**18);
  let totalBalance = BigInt(0);

  for (const walletClient of walletClients) {
    totalBalance += await getBalance(tokenAddress, walletClient.account.address);
  }

  const percentageHeld = (Number(totalBalance) * 100) / Number(totalSupply);

  let tokenName;
  try {
    tokenName = await client.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'name'
    });
  } catch (error) {
    tokenName = 'Unknown Token';
  }

  return `Token: ${tokenName} \n` +
         `Percentage of Total Supply Held: ${percentageHeld.toFixed(4)}%`;
}

async function sellTokensForAllWallets(tokenAddress: EthereumAddress, percentageToSell: number, chatId: number, userId: number, username: string | undefined): Promise<void> {
  const totalSupply = BigInt(1_000_000_000) * BigInt(10**18);
  let totalBalance = BigInt(0);
  const walletBalances: { wallet: any, balance: bigint }[] = [];

  // First, check balances for all wallets
  for (const walletClient of walletClients) {
    const balance = await getBalance(tokenAddress, walletClient.account.address);
    if (balance > BigInt(0)) {
      totalBalance += balance;
      walletBalances.push({ wallet: walletClient, balance });
    }
  }

  // If total balance is 0, stop the process
  if (totalBalance === BigInt(0)) {
    bot?.sendMessage(chatId, `@${username || userId}, No tokens to sell. Total balance is 0.`);
    return;
  }

  const approvalPromises = walletBalances.map(async ({ wallet, balance }) => {
    const account = wallet.account;
    const allowance = await client.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'allowance',
      args: [account.address, UNISWAP_V2_ROUTER_ADDRESS]
    });

    if (allowance < balance) {
      await sendTransactionWithRetry(async (nonce) => {
        return wallet.writeContract({
          address: tokenAddress,
          abi: tokenAbi,
          functionName: 'approve',
          args: [UNISWAP_V2_ROUTER_ADDRESS, balance],
          nonce: nonce,
          gasPrice: await client.getGasPrice()
        });
      }, account.address as EthereumAddress);
    }
  });

  await Promise.all(approvalPromises);

  const totalSellAmount = percentageToSell === 100 ? totalBalance : (totalSupply * BigInt(Math.floor(percentageToSell * 100))) / BigInt(10000);

  if (totalSellAmount > totalBalance) {
    throw new Error(`Not enough tokens to sell ${percentageToSell}% of total supply. You only have ${(Number(totalBalance) * 100 / Number(totalSupply)).toFixed(4)}%`);
  }

  let remainingSellAmount = totalSellAmount;

  for (const { wallet, balance } of walletBalances) {
    if (remainingSellAmount <= BigInt(0)) break;

    const amountToSellFromWallet = balance < remainingSellAmount ? balance : remainingSellAmount;
    let sellSuccessful = false;
    let retryCount = 0;
    const maxRetries = 3;

    while (!sellSuccessful && retryCount < maxRetries) {
      try {
        const txHash = await sendTransactionWithRetry((nonce) => sellTokens(tokenAddress, amountToSellFromWallet, wallet, nonce), wallet.account.address as EthereumAddress);
        
        // Wait for the transaction to be mined
        await client.waitForTransactionReceipt({ hash: txHash });

        // Check the token balance after the transaction
        const newBalance = await getBalance(tokenAddress, wallet.account.address);
        
        if (newBalance < balance) {
          // The balance has decreased, so the sell was successful
          sellSuccessful = true;
          bot?.sendMessage(chatId, `@${username || userId}, Sell transaction hash: ${createTxHashLink(txHash)}`, { parse_mode: 'Markdown' });
          log(`Sale transaction confirmed for wallet ${wallet.account.address}`);
          remainingSellAmount -= (balance - newBalance);
        } else {
          log(`Sale transaction failed for wallet ${wallet.account.address}. Retrying...`);
          retryCount++;
        }
      } catch (error) {
        log(`Failed to sell tokens from wallet ${wallet.account.address}: ${error}`);
        retryCount++;
      }

      if (!sellSuccessful && retryCount < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (!sellSuccessful) {
      bot?.sendMessage(chatId, `@${username || userId}, Failed to sell tokens from wallet ${wallet.account.address} after ${maxRetries} attempts.`);
    }
  }

  const finalTotalBalance = await getTotalBalance(tokenAddress);
  const newPercentageHeld = (Number(finalTotalBalance) * 100) / Number(totalSupply);
  bot?.sendMessage(chatId, `@${username || userId}, Sale process completed. New holdings: ${newPercentageHeld.toFixed(4)}% of total supply.`);
}

async function getTotalBalance(tokenAddress: EthereumAddress): Promise<bigint> {
  let totalBalance = BigInt(0);
  for (const walletClient of walletClients) {
    totalBalance += await getBalance(tokenAddress, walletClient.account.address);
  }
  return totalBalance;
}

async function sendTransactionWithRetry(transactionFunction: (nonce: number) => Promise<`0x${string}`>, accountAddress: EthereumAddress, maxRetries = 10): Promise<`0x${string}`> {
  let attempts = 0;
  let lastError: unknown;
  let nonce: number | null = null;

  while (attempts < maxRetries) {
    try {
      if (nonce === null) {
        nonce = await client.getTransactionCount({ address: accountAddress });
      }

      log(`Attempt ${attempts + 1} to send transaction`);

      try {
        const txHash = await transactionFunction(nonce);
        log(`Transaction successful with hash: ${txHash}`);
        return txHash;
      } catch (error) {
        if (error instanceof Error && (error.message.includes("replacement transaction underpriced") || error.message.includes("nonce too low"))) {
          log(`Transaction attempt ${attempts + 1} failed with error: ${error.message}`);
          lastError = error;

          if (attempts % 3 === 2) {
            nonce++;
            log(`Incrementing nonce to ${nonce}`);
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      log(`Failed to send transaction attempt ${attempts + 1}: ${error}`);
      lastError = error;
      nonce = null;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Failed to send transaction after ${maxRetries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function sellTokens(tokenAddress: EthereumAddress, amount: bigint, walletClient: any, nonce: number): Promise<`0x${string}`> {
  const account = walletClient.account;

  try {
    const ethBalance = await client.getBalance({ address: account.address });
    if (ethBalance === BigInt(0)) {
      throw new Error(`Insufficient ETH balance for wallet ${account.address}. Skipping.`);
    }

    const tokenBalance = await client.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [account.address]
    });

    if (tokenBalance < amount) {
      throw new Error(`Insufficient token balance. Available: ${formatUnits(tokenBalance, 18)}, Trying to sell: ${formatUnits(amount, 18)}`);
    }

    let allowance = await client.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'allowance',
      args: [account.address, UNISWAP_V2_ROUTER_ADDRESS]
    });

    if (allowance < amount) {
      const approveTx = await sendTransactionWithRetry(async (nonce) => {
        return walletClient.writeContract({
          address: tokenAddress,
          abi: tokenAbi,
          functionName: 'approve',
          args: [UNISWAP_V2_ROUTER_ADDRESS, BigInt(2) ** BigInt(256) - BigInt(1)],
          nonce: nonce,
          gasPrice: await client.getGasPrice(),
          gas: GAS_LIMIT  // Use the constant gas limit
        });
      }, account.address);
      log(`Approval transaction hash: ${approveTx}`);

      const approvalReceipt = await client.waitForTransactionReceipt({ hash: approveTx });
      log(`Approval transaction confirmed in block ${approvalReceipt.blockNumber}`);

      allowance = await client.readContract({
        address: tokenAddress,
        abi: tokenAbi,
        functionName: 'allowance',
        args: [account.address, UNISWAP_V2_ROUTER_ADDRESS]
      });

      if (allowance < amount) {
        throw new Error(`Approval failed. Current allowance: ${formatUnits(allowance, 18)}, Required: ${formatUnits(amount, 18)}`);
      }
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
    const amountOutMinimum = BigInt(1);

    const baseGasPrice = await client.getGasPrice();
    const gasPriceWithBump = (attempts: number) => baseGasPrice * BigInt(100 + attempts * 10) / BigInt(100);

    const sellTx = await walletClient.writeContract({
      address: UNISWAP_V2_ROUTER_ADDRESS,
      abi: routerAbi,
      functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
      args: [amount, amountOutMinimum, [tokenAddress, WETH_ADDRESS], account.address, deadline],
      nonce: nonce,
      gasPrice: gasPriceWithBump(0),  // Start with base gas price
      gas: GAS_LIMIT  // Use the constant gas limit
    });

    return sellTx as `0x${string}`;
  } catch (error: any) {
    log(`Error during token sale for wallet ${account.address}: ${error.message}`);
    throw error;
  }
}

async function main() {
  try {
    await initializeBot();
    
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 60000)); // Sleep for a minute
    }
  } catch (error) {
    log('Error in main:', error);
    throw error;
  }
}

main().catch(error => {
  log('Fatal error in main:', error);
  process.exit(1);
});
