// Payload confirmation and channel delivery are independent observations.
import {validateLatestVersion} from '../.github/release-train/npm-channel.mjs';
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const registry=target=>['npm','github-packages'].includes(target);
function payloadMatches(receipt,metadata,target){
 if(receipt?.candidate_sha!==metadata.candidate_sha||receipt.version!==metadata.version||!timestamp(receipt.observed_at)||!(receipt.remote_id||receipt.url)||!/^[a-f0-9]{64}$/.test(metadata.sha256||'')||!/^[a-f0-9]{64}$/.test(receipt.sha256||''))return false;
 return target==='homebrew'?receipt.source_sha256===metadata.sha256:receipt.sha256===metadata.sha256;
}
function channelMatches(receipt,metadata,target){
 if(!registry(target))return true;
 if(!timestamp(receipt.channel_observed_at))return false;
 try{validateLatestVersion(metadata,receipt.latest_version);return true;}catch{return false;}
}
export function receiptIsConfirmed(receipt,metadata,target){
 return receipt?.status==='completed'&&payloadMatches(receipt,metadata,target)&&channelMatches(receipt,metadata,target);
}
export function receiptObservation(receipt,metadata,target){
 if(!receipt)return {status:'not-run'};
 if(['not-run','in-progress'].includes(receipt.status))return {...receipt,bytes_verified:false,channel_blocked:false};
 const payload=payloadMatches(receipt,metadata,target)&&(receipt.status==='completed'||receipt.bytes_verified===true);
 const channel=channelMatches(receipt,metadata,target);
 if(receipt.status==='completed'&&payload&&channel)return receipt;
 const blocked=payload&&registry(target)&&!channel;
 return {...receipt,status:receipt.status==='failed'?'failed':'unknown',bytes_verified:payload,channel_blocked:blocked,reason:receipt.reason||(blocked?'Original package bytes are confirmed; latest channel remains unconfirmed':'Receipt does not confirm the selected sealed payload and channel')};
}
