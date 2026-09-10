import { spawnSync } from 'node:child_process';
const result=spawnSync('docker',['build','-f','demo/Builder.Dockerfile','-t','pac-builder:demo','demo'],{stdio:'inherit'});
if(result.error||result.status!==0){console.error('Docker image setup failed. Start Docker and retry.');process.exit(1);}
console.log('Builder ready. Run npm run demo, then read .pac-demo/owner.token to sign in.');
