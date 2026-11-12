import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAuthenticatedSessionCookie, getAuthenticatedUser, verifyTelegramWebAppInitData } from "../dist/apps/api/src/request-auth.js";

const botToken="123456789:telegram-test-token";
const authSecret="test-session-signing-secret-with-at-least-32-bytes";
process.env.TELEGRAM_BOT_TOKEN=botToken;
process.env.TRANSACTRA_AUTH_HEADER_SECRET=authSecret;

function signedInitData(userId="123456789",authDate=Math.floor(Date.now()/1000)){
 const params=new URLSearchParams({auth_date:String(authDate),query_id:"AAEAA-test",user:JSON.stringify({id:Number(userId),first_name:"Test"})});
 const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
 const secret=createHmac("sha256","WebAppData").update(botToken).digest();
 params.set("hash",createHmac("sha256",secret).update(check).digest("hex"));
 return params.toString();
}

test("Telegram Mini App initData validates and maps to a Telegram subject",()=>{
 const result=verifyTelegramWebAppInitData(signedInitData());
 assert.equal(result?.userId,"telegram:123456789");
});
test("Telegram Mini App initData rejects tampering and stale authentication",()=>{
 const tampered=new URLSearchParams(signedInitData());tampered.set("user",JSON.stringify({id:987654321}));
 assert.equal(verifyTelegramWebAppInitData(tampered.toString()),null);
 assert.equal(verifyTelegramWebAppInitData(signedInitData("123456789",Math.floor(Date.now()/1000)-301)),null);
});
test("Telegram Mini App initData rejects missing bot token",()=>{
 assert.equal(verifyTelegramWebAppInitData(signedInitData(),""),null);
});
test("server-issued HttpOnly session authenticates the Telegram user",()=>{
 const cookie=createAuthenticatedSessionCookie("telegram:123456789");
 assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
 const value=cookie.split(";")[0];
 const req={headers:{cookie:value}};
 assert.equal(getAuthenticatedUser(req),"telegram:123456789");
});
test("session cookie tampering and expired sessions are rejected",()=>{
 const cookie=createAuthenticatedSessionCookie("telegram:123456789").split(";")[0];
 const [name,value]=cookie.split("=");
 const tampered=value.slice(0,-1)+(value.endsWith("a")?"b":"a");
 assert.equal(getAuthenticatedUser({headers:{cookie:name+"="+tampered}}),null);
 const expired=createAuthenticatedSessionCookie("telegram:123456789",Math.floor(Date.now()/1000)-8*60*60-1).split(";")[0];
 assert.equal(getAuthenticatedUser({headers:{cookie:expired}}),null);
});
