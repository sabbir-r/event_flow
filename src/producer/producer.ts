import { EventStreaming } from '../core/broker';
import { ProduceOptions } from '../interface/interface';

export default class Producer {
  private eventStreaming: EventStreaming;
  constructor() {
    this.eventStreaming = new EventStreaming();
  }

  public produce = (opts: ProduceOptions) => {
    this.eventStreaming.produce(opts);
  };

  public produceBatch = (opts: ProduceOptions[]) => {
    this.eventStreaming.produceBatch(opts);
  };
}
