

const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const fs = require('fs');

const okumalar = require('./okumalar.json');

let db = new sqlite3.Database(':memory:');
db.serialize(() => {
  db.run('create table okumalar(id integer primary key, name text not null)')
    .run('create table okuma_maddeler(id integer primary key, name text not null, count integer not null, recommended_portion integer null)');
})

const wsServer = new WebSocketServer({ port: 8080 }, () => console.log(`listening on port ${8080}...`));


wsServer.on('connection', function connection(ws, req) {
  console.log('new connection', req.socket.remoteAddress);
  ws.on('message', (message) => {
    console.log('received: %s', message);
    let data
    try {
      data = JSON.parse(message)
    } catch (e) {
      ws.send(JSON.stringify({message: `message misunderstood: "${data}"`, error: true}));
      return;
    }
    if (data.type === 'get-okumalar') {
      ws.send(JSON.stringify({type: 'okumalar', okumalar, error: false}));
      // fs.readFile('./okumalar.json', (error, data) => {
      //   if (error) throw err;
      // })
    }
  });
  ws.on('open', console.log);
  ws.on('close', console.log);

  // ws.send('something');
});
