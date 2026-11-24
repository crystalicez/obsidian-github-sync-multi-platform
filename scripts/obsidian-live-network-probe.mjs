// Test-only loopback CONNECT tunnel: no TLS termination or payload inspection.
// Restrict outbound tunnels to the actual GitHub API. Never change OS networking,
// shared proxy settings, certificates or the user's normal Obsidian process.
import http from "node:http";
import net from "node:net";

export async function createIsolatedGitHubTunnel(){
 const sockets=new Set();
 let blocked=false,opened=0,refused=0,upBytes=0,downBytes=0;
 const track=socket=>{
  sockets.add(socket);
  socket.on("error",()=>socket.destroy());
  socket.once("close",()=>sockets.delete(socket));
  return socket;
 };
 const server=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
 server.on("connection",track);
 server.on("connect",(req,client,head)=>{
  if(req.url!=="api.github.com:443"||blocked){
   if(req.url==="api.github.com:443"&&blocked)refused++;
   client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
   return;
  }
  const upstream=track(net.connect(443,"api.github.com"));
  const close=()=>{client.destroy();upstream.destroy();};
  client.once("close",close);upstream.once("close",close);
  upstream.once("connect",()=>{
   if(blocked){close();return;}
   opened++;
   client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
   if(head.length){upBytes+=head.length;upstream.write(head);}
   client.on("data",bytes=>{upBytes+=bytes.length;});
   upstream.on("data",bytes=>{downBytes+=bytes.length;});
   client.pipe(upstream);upstream.pipe(client);
  });
 });
 await new Promise((resolve,reject)=>{
  server.once("error",reject);
  server.listen(0,"127.0.0.1",resolve);
 });
 const address=server.address();
 if(!address||typeof address==="string")throw Error("Isolated tunnel did not obtain a loopback port");
 return {
  port:address.port,
  snapshot:()=>({opened,refused,upBytes,downBytes,activeSockets:sockets.size,blocked}),
  cut(){
   blocked=true;
   const count=sockets.size;
   for(const socket of sockets)socket.destroy();
   return count;
  },
  restore(){blocked=false;},
  async close(){
   blocked=true;
   for(const socket of sockets)socket.destroy();
   await new Promise(resolve=>server.close(resolve));
  },
 };
}
