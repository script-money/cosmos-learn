import pkg from '@cosmjs/launchpad';
import {
  QueryClient, setupBankExtension, SigningStargateClient

} from "@cosmjs/stargate";
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import axios from 'axios';
import { createInterface } from "readline";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

async function getUnbondingDelegations(address) {
  return new Promise((resolve) => {
    axios.get(`https://lcd-osmosis.blockapsis.com/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`).then(res => {
      if (res.data.unbonding_responses.length > 0) {
        let unbondingResponse = res.data.unbonding_responses[0];
        let completion = unbondingResponse.entries[0].completion_time;
        resolve(new Date(completion).getTime());
      } else {
        resolve(0)
      }
    }).catch(err => {
      resolve(0)
    })
  })
}
async function getQueryClient(rpcEndpoint) {
  const tendermint34Client = await Tendermint34Client.connect(rpcEndpoint);
  const queryClient = QueryClient.withExtensions(
    tendermint34Client,
    setupBankExtension
  );
  return queryClient;
}

async function transfer(client, from, recipient, amount, txAmount, gasPrice) {
  let ops = [];
  let msg = {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: {
      fromAddress: from,
      toAddress: recipient,
      amount: pkg.coins(amount, "uosmo")
    },
  };
  ops.push(msg);
  const usedFee = {
    amount: pkg.coins(gasPrice, "uosmo"),
    gas: "80000",
  };
  const { accountNumber, sequence } = await client.getSequence(from);
  const chainId = await client.getChainId();

  const txs = [...Array(txAmount).keys()].map(async (i) => {
    const signerData = {
      accountNumber: accountNumber,
      sequence: sequence + i,
      chainId: chainId,
    };
    const txRaw = await client.sign(from, ops, usedFee, '', signerData);
    const txBytes = TxRaw.encode(txRaw).finish();
    return await client.broadcastTx(txBytes, client.broadcastTimeoutMs, client.broadcastPollIntervalMs);
  })

  await Promise.any(txs)
    .then(result => {
      console.log("Your fund is in safe place now. Tx Hash: " + result.transactionHash);
    })
    .catch(err => {
      console.log("Failed. Please try again. " + err);
    });

  process.exit(0);

}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timeLeft(timeLeft) {
  let days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
  let hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  let minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
  let seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
  return `${days} Days, ${hours} Hours, ${minutes} Mins, ${seconds} secs`
}

async function start(mnemonic, recipient) {
  const rpcEndpoint = "https://rpc-osmosis.blockapsis.com/"
  const queryClient = await getQueryClient(rpcEndpoint);
  const wallet = await pkg.Secp256k1HdWallet.fromMnemonic(
    mnemonic, { prefix: 'osmo' }
  );

  const [account] = await wallet.getAccounts();
  let completion = await getUnbondingDelegations(account.address);
  console.log('address', account.address, 'completion', completion);
  let current = new Date().getTime();
  let diff = completion - current;
  //if completion time is less than 5 minutes
  while (diff > 5 * 60 * 1000) {
    current = new Date().getTime();
    diff = completion - current;
    console.log(timeLeft(diff) + " until unbonding completion");
    await sleep(10 * 1000);
  }
  let balance = await queryClient.bank.balance(account.address, "uosmo");
  while (Number(balance.amount) / 1e6 < 0.0001) {
    console.log(`Your account has ${balance.amount / 1e6} OSMO`);
    balance = await queryClient.bank.balance(account.address, "uosmo");
    await sleep(1000);
  }
  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
  console.log(`Ready to transfer ${balance.amount / 1e6} OSMO to ${recipient}`);
  const sequences = 3 // broadcast multiple times to ensure the tx is included in a block
  const gasPrice = 1 // may need greater than the default 0
  transfer(client, account.address, recipient, Number(balance.amount) - sequences * gasPrice, sequences, gasPrice);
}

const readline = createInterface({
  input: process.stdin,
  output: process.stdout
});
readline.question("Please enter your mnemonic:\n", async (mnemonic) => {
  readline.question("Please enter the recipient:\n", async (recipient) => {
    start(mnemonic, recipient);
  });
});