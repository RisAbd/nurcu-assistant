

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
                 oi.id as iid, oi.name as iname,
                 oi.count as icount, oi.recommended_portion as irp,
                 ob.id as obid, cast(strftime('%s', ob.start_ts) as int) as obsts,
                    cast(strftime('%s', ob.end_ts) as int) as obets,
                 obi.id as obiid, obi.user_id, obi.count as obcount,
                    cast(strftime('%s', obi.ts) as int) as ts,
                 obiu.name as user_name
            from okumalar as o
            inner join okuma_items as oi
              on o.id = oi.okuma_id
            left join okuma_batches as ob
              on o.id = ob.okuma_id and ob.end_ts is null
            left join okuma_batch_items as obi
              on ob.id = obi.okuma_batch_id
                and oi.id = obi.okuma_item_id
            left join users as obiu
              on obi.user_id = obiu.id
            order by o.id, oi.id, obi.ts desc
               `, [], function (e, rows) {
          if (e) throw e;
          const okumalar = {}, items = {};
          const okumalarWithoutBatches = [];
          rows.forEach(r => {
            // console.log(r);
            let okuma = okumalar[r.oid];
            if (!okumalar[r.oid]) {
              okuma = okumalar[r.oid] = {
                id: r.oid,
                name: r.oname,
                items: [],
                history: [],
              };
              if (!r.obid) {
                okumalarWithoutBatches.push(r.oid);
              } else {
                const batch = okuma.batch = {
                  id: r.obid,
                  startTs: r.obsts,
                };
              }
            }
            let item = items[r.iid];
            if (!item) {
              item = items[r.iid] = {
                id: r.iid,
                name: r.iname,
                count: r.icount,
                recommendedPortion: r.irp,
                currentCount: 0,
                history: [],
              };
              okumalar[r.oid].items.push(item);
            }
            if (r.obiid) {
              const historyItem = {
                id: r.obiid,
                user: {
                  id: r.user_id,
                  name: r.user_name,
                },
                count: r.obcount,
                ts: r.ts,
                itemId: item.id,
              };
              okuma.history.push(historyItem);
              // item.history.push(historyItem);
              item.currentCount += historyItem.count;
            }
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
