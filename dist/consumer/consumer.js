"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const broker_1 = require("../core/broker");
class Consumer {
    constructor() {
        this.eventStreaming = new broker_1.EventStreaming();
    }
    run(opts, handler) {
        return this.eventStreaming.subscribe(opts, handler);
    }
}
exports.default = Consumer;
