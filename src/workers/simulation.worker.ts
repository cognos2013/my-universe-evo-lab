import { SimulationController } from './controller.ts';
import type { Request } from './controller.ts';
const controller=new SimulationController(reply=>postMessage(reply));
self.onmessage=(event:MessageEvent<Request>)=>{void controller.handle(event.data);};
