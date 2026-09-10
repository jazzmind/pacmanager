// Emit a standard Kubernetes List. This does not provision an EKS cluster.
import { isIP } from 'node:net';
const {PAC_PLATFORM_IMAGE:platform,PAC_BUILDER_IMAGE:builder,PAC_API_CIDRS:cidrs,PAC_PUBLIC_ORIGIN:origin='http://127.0.0.1:3000',PAC_STORAGE_CLASS:storage}=process.env;
if(!platform||!builder||!cidrs)throw new Error('Set PAC_PLATFORM_IMAGE, PAC_BUILDER_IMAGE and PAC_API_CIDRS (actual API server IPv4 addresses/CIDRs).');
for(const image of [platform,builder])if(!/^.+@sha256:[a-f0-9]{64}$/.test(image))throw new Error('Deployment images must use immutable sha256 digests');
const blocks=cidrs.split(',');for(const block of blocks){const [ip,bits]=block.split('/');if(isIP(ip)!==4||!/^\d+$/.test(bits)||Number(bits)>32||Number(bits)<8)throw new Error('Use narrow IPv4 API CIDRs; /0 is forbidden');}
const resource=(apiVersion,kind,name,namespace,extra)=>({apiVersion,kind,metadata:{name,...(namespace?{namespace}:{})},...extra});
const namespace=name=>resource('v1','Namespace',name,null,{metadata:{name,labels:{'pod-security.kubernetes.io/enforce':'restricted','pod-security.kubernetes.io/audit':'restricted','pod-security.kubernetes.io/warn':'restricted'}}});
const deny=ns=>resource('networking.k8s.io/v1','NetworkPolicy','default-deny',ns,{spec:{podSelector:{},policyTypes:['Ingress','Egress']}});
const label={'app.kubernetes.io/name':'pac-manager'};
const items=[namespace('pac-demo'),namespace('pac-builds'),deny('pac-demo'),deny('pac-builds'),
  resource('v1','ResourceQuota','build-budget','pac-builds',{spec:{hard:{pods:'4','requests.cpu':'1','requests.memory':'512Mi','limits.cpu':'2','limits.memory':'1Gi','count/jobs.batch':'10'}}}),
  resource('v1','ServiceAccount','pac-manager','pac-demo',{}),
  resource('rbac.authorization.k8s.io/v1','Role','build-controller','pac-builds',{rules:[{apiGroups:['batch'],resources:['jobs'],verbs:['create','get','delete']},{apiGroups:[''],resources:['pods','pods/log'],verbs:['get','list']}]}),
  resource('rbac.authorization.k8s.io/v1','RoleBinding','pac-manager','pac-builds',{subjects:[{kind:'ServiceAccount',name:'pac-manager',namespace:'pac-demo'}],roleRef:{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:'build-controller'}}),
  resource('networking.k8s.io/v1','NetworkPolicy','controller-to-api','pac-demo',{spec:{podSelector:{matchLabels:label},policyTypes:['Egress'],egress:[{to:blocks.map(cidr=>({ipBlock:{cidr}})),ports:[{protocol:'TCP',port:443}]}]}}),
  resource('v1','PersistentVolumeClaim','pac-data','pac-demo',{spec:{accessModes:['ReadWriteOnce'],resources:{requests:{storage:'1Gi'}},...(storage?{storageClassName:storage}:{})}}),
  resource('apps/v1','Deployment','pac-manager','pac-demo',{spec:{replicas:1,strategy:{type:'Recreate'},selector:{matchLabels:label},template:{metadata:{labels:label},spec:{serviceAccountName:'pac-manager',securityContext:{runAsNonRoot:true,runAsUser:10001,fsGroup:10001,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'manager',image:platform,ports:[{containerPort:3000}],env:[{name:'PAC_BUILDER_IMAGE',value:builder},{name:'PAC_PUBLIC_ORIGIN',value:origin}],securityContext:{readOnlyRootFilesystem:true,allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{cpu:'1',memory:'512Mi'}},readinessProbe:{httpGet:{path:'/health',port:3000},initialDelaySeconds:3},livenessProbe:{httpGet:{path:'/health',port:3000},initialDelaySeconds:15},volumeMounts:[{name:'data',mountPath:'/data'}]}],volumes:[{name:'data',persistentVolumeClaim:{claimName:'pac-data'}}]}}}})
];
console.log(JSON.stringify({apiVersion:'v1',kind:'List',items},null,2));
