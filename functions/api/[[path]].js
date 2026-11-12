export async function onRequest({ request }) {
  const source = new URL(request.url);
  const paymentApi =
    source.pathname === "/api/config" ||
    source.pathname === "/api/transactions" ||
    source.pathname === "/api/parse" ||
    source.pathname === "/api/orders" ||
    source.pathname.startsWith("/api/orders/") ||
    source.pathname.startsWith("/api/auth/paypal/");
  const apiOrigin = paymentApi
    ? "https://transactra-api-production.up.railway.app"
    : "https://transactra-telegram.himaneeshreddyk.workers.dev";
  const target = new URL(apiOrigin + source.pathname + source.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const upstream = new Request(target.toString(), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual"
  });
  return fetch(upstream);
}
