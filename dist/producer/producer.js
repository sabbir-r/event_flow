"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const broker_1 = require("../core/broker");
class Producer {
    constructor() {
        this.produce = (opts) => {
            this.eventStreaming.produce(opts);
        };
        this.produceBatch = (opts) => {
            this.eventStreaming.produceBatch(opts);
        };
        this.eventStreaming = new broker_1.EventStreaming();
    }
}
exports.default = Producer;
