# Log Flow

Log Flow is a lightweight **event-driven pub/sub library for Node.js**.
It allows applications to publish and subscribe to events in a simple and efficient way, similar to a minimal streaming system.

The goal of Log Flow is to provide a **simple alternative to heavy message brokers** when you only need lightweight event streaming inside your Node.js services.

---

## Features

- Simple **Producer / Consumer** model
- Lightweight **Pub/Sub event system**
- Retrieve previous events by **key or time**
- Offset-based event reading
- Minimal setup
- Designed for **high-throughput event flow**

---

## Installation

```bash
npm install log-flow
```

---

## Basic Usage

### Producer

```javascript
const { Producer } = require('log-flow');

const producer = new Producer();

producer.send('user-location', {
  pilgrim_id: 1,
  lat: 23.78,
  lon: 90.41,
});
```

---

### Consumer

```javascript
const { Consumer } = require('log-flow');

const consumer = new Consumer();

consumer.subscribe('user-location', (message) => {
  console.log('New Event:', message);
});
```

---

## Event Structure

Example event stored in the system:

```json
{
  "pilgrim_id": 1,
  "lat": 23.78,
  "lon": 90.41,
  "created_at": "2026-03-07T10:20:00Z"
}
```

---

## Use Cases

Log Flow can be useful for:

- Real-time location tracking
- Event-driven microservices
- Activity logging systems
- Lightweight streaming pipelines
- Notification systems

---

## Project Goal

Log Flow was created to explore **event streaming concepts similar to distributed log systems**, but in a much simpler and lightweight form suitable for Node.js applications.

---

## License

MIT License
