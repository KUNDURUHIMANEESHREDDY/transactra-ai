export async function onRequest({ request }) {
  const source = new URL(request.url);
  const target = new URL("https://transactra-telegram.himaneeshreddyk.workers.dev" + source.pathname + source.search);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const upstream = new Request(target.toString(), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "manual" });
  return fetch(upstream);
}
