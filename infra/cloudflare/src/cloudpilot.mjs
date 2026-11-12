export function cloudPilotConfig(env){
 const secret=typeof env.CLOUDPILOT_INFERENCE_SECRET==="string"?env.CLOUDPILOT_INFERENCE_SECRET:"";
 const raw=typeof env.CLOUDPILOT_INFERENCE_URL==="string"&&env.CLOUDPILOT_INFERENCE_URL.trim()?env.CLOUDPILOT_INFERENCE_URL.trim():"https://cloudpilot-edge.himaneeshreddyk.workers.dev/chat/completions";
 let endpoint;
 try{endpoint=new URL(raw);}catch{return {ok:false,reason:"endpoint_invalid"};}
 if(endpoint.protocol!=="https:"||endpoint.hostname!=="cloudpilot-edge.himaneeshreddyk.workers.dev"||endpoint.pathname!=="/chat/completions"||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)return {ok:false,reason:"endpoint_not_allowlisted"};
 if(secret.length<32)return {ok:false,reason:"shared_secret_missing"};
 return {ok:true,endpoint,secret};
}
export async function completeCloudPilot(env,request){
 const config=cloudPilotConfig(env);
 if(!config.ok)throw new Error("CloudPilot inference is not configured: "+config.reason);
 if(!request||request.estimatedCostInr!==0||typeof request.input!=="string"||!request.input.trim())throw new Error("CloudPilot dispatch requires a non-empty prompt and an exact INR 0 cost estimate");
 const systemPrompt=typeof request.systemPrompt==="string"?request.systemPrompt:"";
 if(new TextEncoder().encode(systemPrompt+request.input).byteLength>8000)throw new Error("CloudPilot input exceeds the 8000-byte limit");
 const maxTokens=Number(request.maxOutputTokens);
 if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>512)throw new Error("CloudPilot output token limit is invalid");
 const model=String(env.NVIDIA_NIM_MODEL||"stepfun-ai/step-5-preview");
 const startedAt=Date.now();
 const response=await fetch(config.endpoint.toString(),{method:"POST",headers:{authorization:"Bearer "+config.secret,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({model,messages:[...(systemPrompt?[{role:"system",content:systemPrompt}]:[]),{role:"user",content:request.input}],max_tokens:maxTokens,temperature:0.2}),redirect:"error",signal:AbortSignal.timeout(125000)});
 if(!response.ok)throw new Error("CloudPilot inference returned HTTP "+response.status);
 const data=await response.json().catch(()=>null);
 const output=data?.choices?.[0]?.message?.content,returnedModel=data?.model;
 const promptTokens=Number(data?.usage?.prompt_tokens),completionTokens=Number(data?.usage?.completion_tokens);
 if(typeof output!=="string"||!output.trim()||returnedModel!==model||!Number.isSafeInteger(promptTokens)||promptTokens<0||!Number.isSafeInteger(completionTokens)||completionTokens<0)throw new Error("CloudPilot returned an invalid or unverifiable completion");
 return {output,provider:"cloudpilot-edge",model:returnedModel,latencyMs:Date.now()-startedAt,usage:{inputTokens:promptTokens,outputTokens:completionTokens}};
}

export function isCloudPilotConfigured(env){ return cloudPilotConfig(env).ok; }
