"use strict";
// Independent read-only receipt/claim/envelope audit; never creates a signing wallet.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { ethers } = require("ethers");
const { encryptAccessKey, accessLinkCommitment } = require("../tests/lib/access-envelope");
const { receiptIdentifier } = require("./receipt-identifiers");
const { safeError } = require("./run-testnet-access");
const STAGE=path.resolve(__dirname,"../..");
require("dotenv").config({path:path.resolve(STAGE,"../../.env"),quiet:true});
const ROOT=path.join(STAGE,"results/access-testnets/2026-10-14");
const networks=[
  ["sepolia",11155111n,"https://sepolia.drpc.org"],
  ["arbitrumSepolia",421614n,process.env.ARBITRUM_SEPOLIA_RPC_URL||"https://sepolia-rollup.arbitrum.io/rpc"],
  ["megaethTestnet",6343n,process.env.MEGAETH_TESTNET_RPC_URL||"https://carrot.megaeth.com/rpc"],
];
const artifact=name=>JSON.parse(fs.readFileSync(path.join(STAGE,`code/artifacts/contracts/${name}.sol/${name}.json`),"utf8"));
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function retry(call){for(let n=0;;++n){try{return await call();}catch(e){if(n===5)throw e;await pause(Math.min(10000,1000*2**n));}}}

async function audit(){
  const results=await Promise.all(networks.map(async([network,id,url])=>{
    const request=new ethers.FetchRequest(url);request.timeout=20000;
    const provider=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1});
    const jobs=[];
    try {
      assert((await retry(()=>provider.getNetwork())).chainId===id,"Unexpected audit chain");
      for(const slicer of ["cura","orca","prusa"]){
        const file=path.join(ROOT,network,`${slicer}.json`);
        if(!fs.existsSync(file))continue;
        const bytes=fs.readFileSync(file),data=JSON.parse(bytes);if(data.outcome!=="Valid")continue;
        assert(data.identity.network===network && data.identity.chain_id===id.toString(),"Checkpoint network mismatch");
        const names=["OVCAccess","OVCIdentitySegmented","OVCConformanceSegmented","OVCFeatureSegmented","BindingPhase"];
        const expected=names.map(n=>`deploy${n}`).concat(["setCoordinatorAccess","setCoordinatorIdentity","setCoordinatorConformance",
          "setCoordinatorFeature","registerAccessPublicKey","bindProvider","disputeClaim","revealWitness"]);
        assert(JSON.stringify(Object.keys(data.operations).sort())===JSON.stringify(expected.sort()),"Operation coverage mismatch");
        for(const n of ["Demand",...names])assert(data.identity.bytecodes[n]===ethers.keccak256(artifact(n).bytecode),`Bytecode mismatch: ${n}`);
        const receipts=[];
        for(const operation of Object.keys(data.operations)){
          const entry=data.operations[operation];assert(!entry.raw,"Public journal contains signed bytes");
          const receipt=await retry(async()=>{const r=await provider.getTransactionReceipt(entry.hash);if(!r)throw Error("Receipt unavailable");return r;});
          assert(receipt.status===1 && receipt.from.toLowerCase()===data.identity.signer.toLowerCase(),"Receipt status/actor mismatch");
          assert(receipt.gasUsed===BigInt(entry.gas_used) && receipt.blockNumber===entry.block_number,"Receipt gas/block mismatch");
          assert(receipt.fee===BigInt(entry.fee_wei),"Receipt fee mismatch");
          if(operation.startsWith("deploy"))assert(receipt.contractAddress.toLowerCase()===entry.contract_address.toLowerCase(),"Deployment address mismatch");
          receipts.push({operation,hash:receipt.hash,block_number:receipt.blockNumber,gas_used:receipt.gasUsed.toString(),fee_wei:receipt.fee.toString(),status:1});
          await pause(75);
        }
        const final=receipts.find(r=>r.operation==="revealWitness"),blockTag=final.block_number;
        const access=new ethers.Contract(data.summary.access_address,artifact("OVCAccess").abi,provider);
        const binding=new ethers.Contract(data.summary.binding_address,artifact("BindingPhase").abi,provider);
        const claim=await retry(()=>access.claims(data.summary.access_claim_id,{blockTag}));
        assert(claim.outcome===2n && claim.state===4n,"Live Access verdict is not Valid/Resolved");
        const bound=await retry(()=>binding.bindings(data.summary.binding_id,{blockTag}));
        const publicKey=Buffer.from(ethers.getBytes(await retry(()=>binding.accessPublicKeys(data.identity.provider,{blockTag}))));
        assert(sha(publicKey)===data.identity.public_key_sha256,"Registered public key hash mismatch");
        const tx=await retry(()=>provider.getTransaction(final.hash));
        const [claimId,witness]=access.interface.decodeFunctionData("revealWitness",tx.data);
        assert(claimId===BigInt(data.summary.access_claim_id),"Wrong final witness claim");
        const opening=Buffer.from(ethers.getBytes(witness));assert(opening.length===64,"Invalid opening length");
        const key=opening.subarray(0,32),seed=opening.subarray(32);
        const envelope=encryptAccessKey(key,publicKey,data.identity.provider,BigInt(data.identity.source_demand_id),seed);
        assert(ethers.hexlify(envelope)===bound.encryptedKey,"Independent RSA public re-encryption failed");
        assert(ethers.keccak256(key)===claim.commitment && ethers.keccak256(publicKey)===claim.providerKeyHash,"Bound key mismatch");
        assert(accessLinkCommitment(key,publicKey,envelope)===claim.auxHash,"Bound linkage mismatch");
        assert(ethers.keccak256(envelope)===ethers.toBeHex(claim.claimValue,32),"Bound envelope hash mismatch");
        const boundReceipt=await retry(()=>provider.getTransactionReceipt(data.operations.bindProvider.hash));
        assert(receiptIdentifier(boundReceipt,binding,"ProviderBound","bindingId","provider",data.identity.provider)===BigInt(data.summary.binding_id),"Receipt-bound identifier mismatch");
        const code=await retry(()=>provider.getCode(access.target,blockTag));assert(code!=="0x","Access runtime code missing");
        jobs.push({network,slicer,artifact_bytes:data.identity.artifact_bytes,outcome:"Valid",journal_sha256:sha(bytes),
          access_address:access.target,binding_address:binding.target,access_runtime_code_hash:ethers.keccak256(code),
          source_demand:data.identity.source_demand,source_demand_id:data.identity.source_demand_id,
          access_dispute_gas:data.summary.access_dispute_gas,binding_gas:data.operations.bindProvider.gas_used,
          complete_artifact_recovered:data.summary.complete_artifact_recovered,reused_ciphertext:true,
          public_reencryption_verified:true,successful_receipts:receipts.length,receipts});
      }
      return {network,jobs};
    }catch(error){return {network,jobs,error:safeError(error)};}finally{provider.destroy();}
  }));
  const jobs=results.flatMap(r=>r.jobs),seen=new Set();
  for(const j of jobs)for(const r of j.receipts){const key=`${j.network}:${r.hash}`;assert(!seen.has(key),"Duplicate receipt");seen.add(key);}
  const fees={};for(const n of results)fees[n.network]=ethers.formatEther(n.jobs.flatMap(j=>j.receipts).reduce((x,r)=>x+BigInt(r.fee_wei),0n));
  const report={observed_at_utc:new Date().toISOString(),completed_jobs:jobs.length,verified_unique_successful_receipts:seen.size,
    fees_native_test_eth_including_deployment_and_setup:fees,networks:results,limitations:[
      "Existing sealed Demand ciphertext is reused; this campaign does not pay for or measure new full-file uploads.",
      "Consumer and Provider use the same test EOA, with separate RSA keys; multi-account authorization is covered locally.",
      "Artifact keys are already public Identity fixtures; functional key handover is not a confidentiality proof.",
      "Only Access adjudication is executed by this campaign; other claim contracts are instantiated but not disputed.",
      "One run per slicer/network; timings include deliberate pacing and readback, and resumed runs include interruptions."]};
  fs.writeFileSync(path.join(ROOT,"rpc-audit.json"),JSON.stringify(report,null,2)+"\n");
  const headers=["network","slicer","artifact_bytes","access_dispute_gas","binding_gas","successful_receipts","outcome"];
  fs.writeFileSync(path.join(ROOT,"access-comparison.csv"),[headers.join(","),...jobs.map(j=>headers.map(h=>j[h]).join(","))].join("\n")+"\n");
  console.log(JSON.stringify({completed_jobs:jobs.length,verified_receipts:seen.size,fees,errors:results.filter(r=>r.error).map(r=>({network:r.network,error:r.error}))},null,2));
  if(results.some(r=>r.error)||(process.argv.includes("--require-complete")&&jobs.length!==9))process.exitCode=1;
}
audit().catch(error=>{console.error(safeError(error));process.exitCode=1;});
