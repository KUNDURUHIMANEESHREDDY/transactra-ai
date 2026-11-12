import test from "node:test";
import assert from "node:assert/strict";
import { handleObservabilityRoute } from "../dist/apps/api/src/observability.js";
import { signAuthenticatedUser } from "../dist/apps/api/src/request-auth.js";

process.env.TRANSACTRA_AUTH_HEADER_SECRET="test-observability-secret-with-at-least-32-bytes";
function request(method,url,userId){
 const timestamp=String(Math.floor(Date.now()/1000));
 return {method,url,headers:userId?{"x-transactra-user-id":userId,"x-transactra-auth-timestamp":timestamp,"x-transactra-auth-signature":signAuthenticatedUser(userId,Number(timestamp))}:{}}; 
}
function response(){
 return {status:0,headers:{},body:"",writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body||"";}};
}
test("observability endpoints reject missing or invalid authenticated identity",async()=>{
 const res=response(),handled=await handleObservabilityRoute(request("GET","/api/observability/overview"),res,new URL("http://localhost/api/observability/overview"),{query:async()=>({rows:[]})});
 assert.equal(handled,true);assert.equal(res.status,401);assert.match(res.body,/authenticated/i);
});
test("observability endpoints are read-only",async()=>{
 const req=request("POST","/api/observability/overview","telegram:123"),res=response();
 await handleObservabilityRoute(req,res,new URL("http://localhost/api/observability/overview"),{query:async()=>({rows:[]})});
 assert.equal(res.status,405);
});
test("transaction ledger queries are scoped to the authenticated user",async()=>{
 const calls=[],db={query:async(sql,params)=>{calls.push({sql,params});if(sql.includes("FROM owners"))return {rows:[{id:"owner-1"}]};if(sql.includes("FROM payment_transactions"))return {rows:[{id:"tx-1",status:"COMPLETED"}]};throw new Error("Unexpected query");}};
 const userId="telegram:123",res=response(),url=new URL("http://localhost/api/observability/transactions?limit=25");
 await handleObservabilityRoute(request("GET",url.pathname+url.search,userId),res,url,db);
 assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body).transactions,[{id:"tx-1",status:"COMPLETED"}]);
 const ledger=calls.find(x=>x.sql.includes("FROM payment_transactions"));
 assert.ok(ledger.sql.includes("WHERE user_id=$1"));assert.equal(ledger.params[0],userId);assert.equal(ledger.params[1],25);
});
