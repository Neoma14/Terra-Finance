const {spawn}=require("child_process"),crypto=require("crypto"),fs=require("fs");
const path=require("path");const WORK=path.resolve(process.argv[2]),C=path.resolve(__dirname,"../.."),mode=process.argv[3];const W=WORK+"/data";
const env={...process.env,NODE_ENV:"production",PORT:"4531",DB_FILE_PATH:W+"/terra-finance.sqlite",SYSTEM_DB_FILE_PATH:W+"/terra-system.sqlite",COMPANY_DATA_ROOT:W+"/companies",STATIC_WEB_DIR:C+"/apps/web/dist",SESSION_SECRET:crypto.createHash("sha256").update("ui").digest("hex")};
const log=fs.openSync(WORK+"/server.log","w");
const p=spawn(process.execPath,[C+"/apps/api/dist/server.js"],{env,cwd:C+"/apps/api",stdio:["ignore",log,log],detached:mode==="keep"});
if(mode==="keep"){fs.writeFileSync(WORK+"/server.pid",String(p.pid));p.unref();setTimeout(()=>process.exit(0),500)}
else(async()=>{for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:4531/api/health")).ok)break}catch{}await new Promise(r=>setTimeout(r,400))}await new Promise(r=>setTimeout(r,2500));p.kill();await new Promise(r=>setTimeout(r,1500));console.log("migrated")})();
