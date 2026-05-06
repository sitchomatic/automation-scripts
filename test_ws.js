import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', function open() {
  console.log('Connected to server');
  ws.send(JSON.stringify({ type: 'start' }));
});

ws.on('message', function incoming(data) {
  const msg = data.toString();
  try {
    const parsed = JSON.parse(msg);
    if (parsed.type === 'screenshot') {
      console.log('Received: [Screenshot omitted]');
    } else {
      console.log('Received:', JSON.stringify(parsed, null, 2));
    }
  } catch (e) {
    console.log('Received:', msg);
  }
});

ws.on('close', function close() {
  console.log('Disconnected');
});

