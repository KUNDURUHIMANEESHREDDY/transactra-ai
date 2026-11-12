import {useEffect,useMemo,useState} from "react";
type Intent={amount:string;currency:string;recipient:string;purpose:string;confidence:number;source:"rules"|"model"};
type Tx={id:string;recipient:string;purpose:string;amount:string;currency:string;status:string;created_at:string};
type ConnectedAccount={payerId:string;email:string|null;name:string|null;verified:boolean;connectedAt:string;scope:string|null};
declare global{interface Window{paypal?:{Buttons:(options:Record<string,unknown>)=>{render:(selector:string)=>Promise<void>}}}}
const money=(a:string,c:string)=>new Intl.NumberFormat("en-US",{style:"currency",currency:c}).format(Number(a));
export default function App(){
 const [prompt,setPrompt]=useState("Pay $24.50 to Alex for dinner"),[intent,setIntent]=useState<Intent|null>(null),[tx,setTx]=useState<Tx[]>([]),[clientId,setClientId]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[parsing,setParsing]=useState(false),[activity,setActivity]=useState(false),[buttons,setButtons]=useState(false),[connected,setConnected]=useState(false),[account,setAccount]=useState<ConnectedAccount|null>(null);
 async function refresh(){try{const [c,t,s]=await Promise.all([fetch("/api/config"),fetch("/api/transactions"),fetch("/api/auth/paypal/status")]);if(c.ok){const x=await c.json();setClientId(x.paypalClientId||"");}if(t.ok){const x=await t.json();setTx(x.transactions||[]);}if(s.ok){const x=await s.json();setConnected(Boolean(x.connected));setAccount(x.account||null);}}catch{/* API connection status is shown inline */}}
 useEffect(()=>{
  const p=new URLSearchParams(window.location.search);
  const status=p.get("paypal_connection");
  const reason=p.get("reason");
  if(status==="success"){
   setNotice("PayPal account successfully connected via OAuth 2.0! Identity verified.");
   window.history.replaceState({},document.title,window.location.pathname);
  }else if(status==="error"){
   setError("PayPal connection failed: "+(reason||"OAuth consent was rejected or expired."));
   window.history.replaceState({},document.title,window.location.pathname);
  }
  void refresh();
 },[]);
 const completed=useMemo(()=>tx.filter(x=>x.status==="COMPLETED"),[tx]),total=useMemo(()=>completed.reduce((s,x)=>s+Number(x.amount),0),[completed]);
 async function understand(){setError("");setNotice("");setIntent(null);setParsing(true);try{const r=await fetch("/api/parse",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:prompt})});const d=await r.json();if(!r.ok)throw Error(d.error||"Could not parse request");setIntent(d.intent);}catch(e){setError(e instanceof Error?e.message:"Unable to parse request");}finally{setParsing(false);}}
 async function checkout(){if(!clientId){setError("PayPal Sandbox is not configured. Add the Sandbox client ID and secret to the API environment.");return;}setBusy(true);setError("");try{
  if(!window.paypal){await new Promise<void>((resolve,reject)=>{const s=document.createElement("script");s.src="https://www.paypal.com/sdk/js?client-id="+encodeURIComponent(clientId)+"&currency="+(intent?.currency||"USD")+"&intent=capture";s.onload=()=>resolve();s.onerror=()=>reject(Error("PayPal Checkout SDK could not load."));document.head.appendChild(s);});}
  if(!window.paypal)throw Error("PayPal SDK did not initialize.");
  const host=document.getElementById("paypal-button-host");if(!host)throw Error("Checkout panel unavailable.");host.innerHTML="";
  const instance=window.paypal.Buttons({
   style:{layout:"vertical",color:"gold",shape:"rect",label:"paypal",height:48},
   createOrder:async()=>{const r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...intent,rawPrompt:prompt})});const d=await r.json();if(!r.ok)throw Error(d.error||"Unable to create PayPal order");return d.orderId;},
   onApprove:async(data:{orderID:string})=>{const r=await fetch("/api/orders/"+encodeURIComponent(data.orderID)+"/capture",{method:"POST"});const d=await r.json();if(!r.ok)throw Error(d.error||"PayPal capture failed");setNotice(d.status==="COMPLETED"?"Payment captured successfully in PayPal Sandbox.":"PayPal returned status: "+d.status);setIntent(null);setActivity(true);await refresh();},
   onCancel:()=>setNotice("Checkout cancelled. No payment was captured."),
   onError:(e:unknown)=>setError(e instanceof Error?e.message:"PayPal checkout failed.")
  });
  await instance.render("#paypal-button-host");setButtons(true);
 }catch(e){setError(e instanceof Error?e.message:"Unable to start checkout");}finally{setBusy(false);}}
 async function disconnectAccount(){if(!confirm("Are you sure you want to disconnect your PayPal account?"))return;setBusy(true);setError("");setNotice("");try{const r=await fetch("/api/auth/paypal/disconnect",{method:"POST"});const d=await r.json();if(!r.ok)throw Error(d.error||"Failed to disconnect account");setNotice("PayPal account disconnected.");await refresh();}catch(e){setError(e instanceof Error?e.message:"Failed to disconnect account");}finally{setBusy(false);}}
 function newPayment(){setActivity(false);setIntent(null);setPrompt("");setError("");setNotice("");setButtons(false);}
 return <div className="shell">
  <aside className="sidebar"><a className="brand" href="#"><span className="mark"><i/><i/><i/></span>transactra<span className="dot">.</span></a><div className="side-label">WORKSPACE</div>
   <button className={!activity?"nav active":"nav"} onClick={()=>setActivity(false)}><b>⌁</b> Payment desk <small>⌘1</small></button>
   <button className={activity?"nav active":"nav"} onClick={()=>setActivity(true)}><b>◷</b> Activity <small>{tx.length}</small></button>
   <div className="side-bottom"><div className="sandbox"><span className="pulse"/> <div><strong>Sandbox mode</strong><small>Test transactions only</small></div><em>TEST</em></div><div className="profile"><span className="avatar">{account?.name?.[0]||"T"}</span><div><strong>{account?.name||"Transactra workspace"}</strong><small style={{color:connected?"#40c69b":"#8190aa"}}>{connected?"PayPal Connected ✓":"Personal account"}</small></div><span className="dots">···</span></div></div>
  </aside>
  <main><header className="topbar"><div>Workspace <span>/</span> <strong>{activity?"Activity":"Payment desk"}</strong></div><div className="env"><i/> PAYPAL SANDBOX <span className="user">{account?.name?.[0]||"T"}</span></div></header>
   <div className="content">{!activity?<><section className="hero"><div><div className="eyebrow"><i/> YOUR AI PAYMENT ASSISTANT</div><h1>Payments,<br/><em>understood.</em></h1><p>Say what needs to be paid. Transactra turns your words into a clear, reviewable PayPal checkout.</p></div><div className="seal"><div>T<span>✳</span></div><small>INTENT → APPROVAL<br/>→ SETTLEMENT</small></div></section>
    <section className="paypal-card">
     <div className="paypal-card-info">
      <div className="paypal-card-head">
       <h3>PayPal Account Connection</h3>
       <span className={`status-pill ${connected?"connected":"disconnected"}`}>{connected?"CONNECTED ✓":"NOT CONNECTED"}</span>
      </div>
      {connected&&account?(
       <>
        <p>Your PayPal identity is securely connected via OAuth 2.0.</p>
        <div className="paypal-meta">
         <span>Account: <strong>{account.email||account.name||account.payerId}</strong></span>
         <span>Payer ID: <strong>{account.payerId}</strong></span>
         {account.verified&&<span className="chip">VERIFIED PAYPAL ACCOUNT</span>}
        </div>
        <div className="id-note">
         <span>🔒 Identity & Consent:</span> Transactra associates your verified PayPal identity. Payment execution remains protected behind separate, review-first buyer approval.
        </div>
       </>
      ):(
       <>
        <p>Connect your official PayPal account via OAuth 2.0 to link your identity. No money moves without your explicit per-order approval.</p>
        <div className="id-note">
         <span>🔒 Secure OAuth 2.0:</span> Uses official PayPal OpenID consent, single-use state validation, and AES-256-GCM token encryption.
        </div>
       </>
      )}
     </div>
     <div className="paypal-actions">
      {connected?(
       <button className="disconnect-btn" onClick={disconnectAccount} disabled={busy}>Disconnect account</button>
      ):(
       <a className="paypal-btn" href="/api/auth/paypal/connect">
        <svg viewBox="0 0 24 24"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72a.774.774 0 0 1 .763-.645h7.108c3.21 0 5.485 1.572 4.965 4.887-.456 2.91-2.482 4.606-5.467 4.606h-2.07l-1.025 6.51a.64.64 0 0 1-.633.535l-.509.724z"/></svg>
        Connect PayPal
       </a>
      )}
     </div>
    </section>
    <section className="metrics"><div><label>COMPLETED PAYMENTS</label><strong>{String(completed.length).padStart(2,"0")}</strong><small>Sandbox captures</small></div><div><label>TOTAL CAPTURED</label><strong>{money(total.toFixed(2),"USD")}</strong><small>Confirmed by PayPal</small></div><div><label>PAYMENT RAIL</label><strong className="rail">PayPal <span>↗</span></strong><small>Orders API v2 · Capture</small></div></section>
    <section className="grid"><div className="panel compose"><div className="panel-head"><div><label>PAYMENT REQUEST</label><h2>What would you like to pay?</h2></div><span className="chip">✳ AI ASSISTED</span></div><label className="field-label" htmlFor="request">DESCRIBE YOUR PAYMENT</label><textarea id="request" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="e.g. Pay $48 to Morgan for the team lunch..." rows={3}/><div className="hints"><span>TRY</span><button onClick={()=>setPrompt("Pay $48 to Morgan for team lunch")}>Team lunch</button><button onClick={()=>setPrompt("Send 120 USD to Studio North for logo design")}>Design invoice</button><button onClick={()=>setPrompt("Pay ₹850 to Riya for cab fare")}>Cab fare</button></div>
     {error&&<div className="alert error" role="alert">{error}</div>}{notice&&<div className="alert success" role="status">{notice}</div>}
     <button className="primary" onClick={understand} disabled={parsing||!prompt.trim()}>{parsing?"Understanding request…":"Understand payment"} <span>↗</span></button><div className="privacy">⌑ &nbsp;Nothing moves until you review and approve it.</div></div>
    <div className="panel explainer"><div className="panel-head"><label>HOW IT WORKS</label><span className="spark">✳</span></div><div className="flow"><b>⌁</b><div><strong>Understand</strong><small>AI structures your request into payment details.</small></div></div><div className="connector"/><div className="flow"><b>◉</b><div><strong>Review & approve</strong><small>You check every detail before checkout.</small></div></div><div className="connector"/><div className="flow"><b>↗</b><div><strong>Pay with PayPal</strong><small>Sandbox order, buyer approval, real capture API.</small></div></div><footer>BUILT AROUND EXPLICIT HUMAN APPROVAL</footer></div></section>
    {intent&&<section className="panel review"><div className="review-head"><div><label>REVIEW BEFORE CHECKOUT</label><h2>Here's what Transactra understood.</h2></div><span className="ready">READY FOR YOUR APPROVAL</span></div><div className="details"><div className="amount"><label>PAYMENT AMOUNT</label><strong>{money(intent.amount,intent.currency)}</strong><small>{intent.currency} · PayPal Sandbox</small></div><div><label>RECIPIENT / MERCHANT LABEL</label><strong>{intent.recipient}</strong></div><div><label>PAYMENT PURPOSE</label><strong>{intent.purpose}</strong></div></div><div className="disclosure">ⓘ &nbsp;PayPal Checkout charges the merchant account connected to these Sandbox credentials. The recipient above is a transaction label; third-party payee routing requires an eligible PayPal multiparty/platform integration.</div><div className="checkout-row"><div><strong>Review complete?</strong><small>Continue to PayPal to approve and capture this Sandbox payment.</small></div><button className="secondary" onClick={()=>setIntent(null)}>Edit request</button></div>{!buttons?<button className="primary" onClick={checkout} disabled={busy}>{busy?"Preparing PayPal…":"Continue to PayPal checkout"} <span>↗</span></button>:<div id="paypal-button-host" className="paypal-host"/>}</section>}
    <div className="bottom-note">✳ &nbsp;AI helps interpret intent. You remain in control of every payment.</div>
   </>:<section className="activity"><div className="activity-head"><div><div className="eyebrow"><i/> PAYMENT LEDGER</div><h1>Activity<span>.</span></h1><p>Every Sandbox order and capture, in one place.</p></div><button className="primary compact" onClick={newPayment}>New payment ↗</button></div><div className="stats"><div><label>ALL TRANSACTIONS</label><strong>{tx.length}</strong></div><div><label>COMPLETED</label><strong>{completed.length}</strong></div><div><label>CAPTURED VALUE</label><strong>{money(total.toFixed(2),"USD")}</strong></div></div><div className="table"><header><strong>Recent transactions</strong><small>LIVE FROM POSTGRESQL</small></header>{tx.length===0?<div className="empty"><b>◷</b><strong>No payments yet</strong><p>Your completed Sandbox checkouts will appear here.</p><button className="secondary" onClick={newPayment}>Create your first payment</button></div>:<><div className="row labels"><span>RECIPIENT</span><span>PURPOSE</span><span>DATE</span><span>AMOUNT</span><span>STATUS</span></div>{tx.map(x=><div className="row" key={x.id}><strong>{x.recipient}</strong><span>{x.purpose}</span><span>{new Date(x.created_at).toLocaleString()}</span><strong>{money(x.amount,x.currency)}</strong><em className={x.status==="COMPLETED"?"done":"pending"}>{x.status}</em></div>)}</>}</div></section>}</div>
  </main>
 </div>;
}
