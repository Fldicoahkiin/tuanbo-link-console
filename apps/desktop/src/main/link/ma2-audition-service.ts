import { randomUUID } from 'node:crypto';
import { ma2AuditionRequestSchema, ma2AuditionStateSchema, type Ma2AuditionRequest, type Ma2AuditionState, type Ma2PlaybackRequest } from '@tb/schema';
type Target=Ma2AuditionState['targets'][number]&{epoch:number;possiblySent:boolean;pending:number};
/** Upper bound per Off, beyond the 7 s send deadline the transport already enforces. */
const offTimeoutMs=8000;
export type AuditionNetwork={readonly connectionGeneration:number;cancelPlayback:(id:string)=>void;playCue:(request:Ma2PlaybackRequest,options?:{beforeSend?:()=>void;priority?:'normal'|'stop'})=>Promise<unknown>};
/** App-lifetime ownership of audition outputs. Component cancellation never forgets lit targets. */
export class Ma2AuditionService {
  private targets=new Map<string,Target>();private sessions=new Map<string,number>();
  private generation=0;private revision=0;private phase:Ma2AuditionState['phase']='idle';private stopping:Promise<Ma2AuditionState>|null=null;private connectionChanging=false;
  constructor(private readonly network:AuditionNetwork,private readonly publish:(state:Ma2AuditionState)=>void=()=>undefined){}
  status():Ma2AuditionState{return ma2AuditionStateSchema.parse({version:1,revision:this.revision,generation:this.generation,phase:this.phase,targets:[...this.targets.values()].map(({id,network,action,state,error,epoch})=>({id,network,action,state,error,connectionChanged:epoch!==this.network.connectionGeneration}))});}
  private changed():void{this.revision++;this.publish(this.status());}
  /** Human acknowledgement only; never send an old target to a different connection. */
  acknowledgeClosed(targetId:string):Ma2AuditionState{
    if(this.stopping)throw new Error('正在停止试听，请稍后再看');
    const target=this.targets.get(targetId);
    if(!target||target.epoch===this.network.connectionGeneration||target.state!=='failed'||target.pending)throw new Error('这条记录已经不需要确认了，请刷新后查看');
    this.targets.delete(targetId);
    this.phase=[...this.targets.values()].some(value=>value.state==='failed')?'failed':this.targets.size?'active':'idle';
    this.changed();return this.status();
  }
  async beforeConnectionChange():Promise<()=>void>{
    if(this.connectionChanging)throw new Error('正在切换控台连接');
    this.connectionChanging=true;
    try{
      const result=await this.stop();
      if(result.phase==='failed')throw new Error('切换连接前没能停止试听，请在灯光工作台查看没停下的目标');
      return()=>{this.connectionChanging=false;};
    }catch(error){this.connectionChanging=false;throw error;}
  }
  async play(input:Ma2AuditionRequest):Promise<void>{
    const request=ma2AuditionRequestSchema.parse(input);
    if(this.stopping||this.connectionChanging||request.generation!==this.generation)throw new Error('试听已停止或正在切换连接，请重新点击 Cue');
    const epoch=this.network.connectionGeneration;const action=request.action;
    const off=action.target==='sequence'?{target:'sequence' as const,sequence:action.sequence,action:'off' as const}:{target:'executor' as const,executor:action.executor,action:'off' as const};
    const id=JSON.stringify([request.network.host,request.network.port,request.network.monitorPort,request.network.username,epoch,off]);
    const target=this.targets.get(id)??{id,epoch,network:request.network,action:off,state:'pending' as const,error:null,possiblySent:false,pending:0};
    target.pending++;this.targets.set(id,target);this.sessions.set(request.sessionId,(this.sessions.get(request.sessionId)??0)+1);this.phase='active';this.changed();
    try{
      const {generation,network,action,sessionId,deadlineAt}=request;
      const payload={network,action,sessionId,deadlineAt};
      await this.network.playCue(payload,{beforeSend:()=>{
        if(this.stopping||generation!==this.generation||epoch!==this.network.connectionGeneration)throw new Error('试听已停止，取消旧 Cue');
        target.possiblySent=true;target.state='unknown';this.changed();
      }});
      if(this.targets.get(id)===target){if(action.action==='off')this.targets.delete(id);else{target.state='sent';target.error=null;}}
    }catch(error){if(this.targets.get(id)===target&&target.possiblySent){target.state='unknown';target.error=error instanceof Error?error.message:String(error);}throw error;}
    finally{target.pending--;if(!target.pending&&!target.possiblySent&&this.targets.get(id)===target)this.targets.delete(id);const count=(this.sessions.get(request.sessionId)??1)-1;if(count)this.sessions.set(request.sessionId,count);else this.sessions.delete(request.sessionId);this.changed();}
  }
  stop():Promise<Ma2AuditionState>{
    if(this.stopping)return this.stopping;
    this.generation++;this.phase='stopping';for(const id of this.sessions.keys())this.network.cancelPlayback(id);
    const targets=[...this.targets.values()];for(const target of targets)if(!target.possiblySent)this.targets.delete(target.id);
    this.stopping=Promise.resolve().then(async()=>{
      // The phase always leaves 'stopping', even when publishing state fails;
      // otherwise every later Cue click is refused until the app restarts.
      // A failed publish never holds back the Offs; it is reported after them.
      let published:Error|null=null;
      try{
        try{this.changed();}catch(error){published=error instanceof Error?error:new Error(String(error));}
        // Queue every Off at once so they reach the wire back to back at stop priority.
        await Promise.all(targets.filter(value=>value.possiblySent).map(async target=>{
          try{
            if(target.epoch!==this.network.connectionGeneration)throw new Error('控台连接变了，还没确认原来的试听已关闭');
            await this.sendOff(target);
            this.targets.delete(target.id);
          }catch(error){target.state='failed';target.error=error instanceof Error?error.message:String(error);}
        }));
      }finally{this.phase=this.targets.size?'failed':'sent';this.changed();}
      if(published)throw published;
      return this.status();
    }).finally(()=>{this.stopping=null;});return this.stopping;
  }
  private async sendOff(target:Target):Promise<void>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`停止指令发出 ${offTimeoutMs/1000} 秒后还没确认关闭，灯光可能还亮着。请再停一次，或到控台上确认`)),offTimeoutMs);});
    try{await Promise.race([this.network.playCue({network:target.network,action:target.action,sessionId:randomUUID(),deadlineAt:Date.now()+7000},{priority:'stop',beforeSend:()=>{if(target.epoch!==this.network.connectionGeneration)throw new Error('控台连接变了，停止指令没有发送');}}),timeout]);}
    finally{clearTimeout(timer);}
  }
}
