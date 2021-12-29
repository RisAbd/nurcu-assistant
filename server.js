

const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

// const okumalar = require('./okumalar.json');
let okumaHistoryId = 1;

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server, { /* options */ });

const port = process.env.PORT || 3000;// server listening for client connection

function dbConnect(callback) {
  const db = new sqlite3.Database('./db.sqlite3');
  db.get('PRAGMA foreign_keys = ON');
  if (!callback) {
    return db;
  }
  callback(db);
  db.close();
}


app.use('/static/', express.static(__dirname + '/static'));
app.get('/', function index(req, res) {
  res.sendFile(__dirname + '/index.html');
});
app.get('/okumalar.json', (req, res) => {
  res.sendFile(__dirname + '/okumalar.json');
});

io.on('connection', socket => {
  console.debug(`[connect]: ${socket.id}`);

  socket.on('disconnect', () => {
    console.debug(`[disconnect] ${socket.id}`);
  });

  socket.on('create-user', ({name}, callback) => {
    console.debug(`[create-user] ${name}`);
    dbConnect(db => {;
      db.run(`INSERT INTO users(name) VALUES (?)`, [name], function (e) {
        if (e) throw e;
        db.get(`SELECT id, is_active, name FROM users WHERE id = ?`, [this.lastID], (e, row) => {
          if (e) throw e;
          console.debug(`[create-user]:callback(${JSON.stringify(row)})`);
          callback(row);
        });
      });
    });
  });

  socket.on('get-user', ({id}, callback) => {
    console.debug(`[get-user] ${id}`);
    dbConnect(db => {
      db.get(`SELECT id, is_active, name FROM users WHERE id = ?`, [id], (e, row) => {
        if (e) throw e;
        console.debug(`[get-user]:callback(${JSON.stringify(row)})`);
        callback(row);
      });
    });
  });

  socket.on('set-user-name', ({id: userId, name}, callback) => {
    console.debug(`[set-user-name] ${userId}, ${name}`);
    dbConnect(db => {
      db.serialize(() => {
        db.run(`UPDATE users SET name = ? WHERE id = ?`, [name, userId])
        db.get(`SELECT id, is_active, name FROM users WHERE id = ?`, [userId], function (e, user) {
          if (e) throw e;
          console.debug(`[set-user-name]:callback(${JSON.stringify(user)}`);
          callback(user);
        })
      })
    })
  });


  socket.on('get-okumalar-list', callback => {
    console.debug('[get-okumalar-list]', callback);
    dbConnect(db => {
      db.serialize(() => {
        db.all(`
          select o.id as oid, o.name as oname,
                 i.id as iid, i.name as iname,
                 i.count as icount, i.recommended_portion as irp
            from okumalar as o
            inner join okuma_items as i
              on o.id = i.okuma_id
               `, [], function (e, rows) {
          const okumalar = {}
          rows.forEach(r => {
            if (!okumalar[r.oid]) {
              okumalar[r.oid] = {
                id: r.oid,
                name: r.oname,
                items: [],
              };
            }
            okumalar[r.oid].items.push({
              id: r.iid,
              name: r.iname,
              count: r.icount,
              recommendedPortion: r.irp,
            });
          });
          callback({items: Object.values(okumalar)});
        })
      })
    })
    // callback(okumalar);
  });

  socket.on('get-okuma', ({userId, count, id: subitemId}, callback) => {
    console.debug(`[get-okuma](${userId}, ${count}, ${subitemId})`)
    dbConnect(db => {
      db.get(`SELECT id, is_active, name FROM users WHERE id = ?`, [userId], (e, user) => {
        if (e) throw e;
        for (let item of okumalar.items) {
          for (let subitem of item.subitems) {
            if (subitem.id === subitemId) {
              subitem.currentCount = (subitem.currentCount || 0) + count;
              const okumaHistory = {id: okumaHistoryId++, user, count, ts: Date.now()/1000, subitemId};
              item.history = [...(item.history || []), okumaHistory];
              io.emit('got-okuma', subitem, okumaHistory);
              console.debug(`[got-okuma]:emit(${JSON.stringify(subitem)}, ${JSON.stringify(okumaHistory)})`)
              callback(subitem, okumaHistory);
              return;
            }
          }
        }
      });
    })
  });
});


server.listen(port, () => console.log(`Server is listening on port ${port}`));
