

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
      db.all(`
        select o.id as oid, o.name as oname, o.is_active, o.read_sequentially,
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

          where o.is_active

          order by o.id, oi.id, obi.ts
             `, [], function (e, rows) {
        if (e) throw e;
        const okumalar = {}, items = {};
        rows.forEach(r => {
          // console.log(r);
          let okuma = okumalar[r.oid];
          if (!okumalar[r.oid]) {
            okuma = okumalar[r.oid] = {
              id: r.oid,
              name: r.oname,
              isActive: Boolean(r.is_active),
              readSequentially: Boolean(r.read_sequentially),
              items: [],
              history: [],
            };
            if (!r.obid) {
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
    // callback(okumalar);
  });

  socket.on('get-okuma', ({userId, count, itemId}, callback) => {
    console.debug(`[get-okuma](${userId}, ${count}, ${itemId})`)
    dbConnect(db => {
      db.all(`SELECT
                  o.id as oid,
                  oi.id as itemId,
                  oi.count as totalCount,
                  oi.name as itemName,
                  oi.recommended_portion as itemRP,
                  ob.id as obid,
                  obi.count as obicount

                FROM okumalar AS o
                INNER JOIN okuma_items AS oi ON o.id = oi.okuma_id
                LEFT JOIN okuma_batches AS ob ON o.id = ob.okuma_id AND ob.end_ts IS NULL
                LEFT JOIN okuma_batch_items AS obi ON obi.okuma_batch_id = ob.id AND oi.id = obi.okuma_item_id

                WHERE oi.id = ?
                ORDER BY obi.ts
                `, [itemId], function (e, rows) {
        if (e) throw e;
        // console.debug(rows);
        if (rows.length === 0) {
          throw new Error(`no such itemId: ${itemId}`);
        }
        const {oid: okumaId, obid: okumaBatchId, totalCount, itemName, itemRP} = rows[0];

        const checkCurrentCount = currentCount => {
          if (currentCount+count > totalCount) {
            throw new Error(`user wants too many: ${currentCount+count} > ${totalCount}`);
          }
        };

        const createHistoryAndResponse = (okumaBatchId, currentCount) => new Promise((resolve, reject) => {
          db.run(`INSERT INTO okuma_batch_items(okuma_batch_id, okuma_item_id, user_id, count)
            VALUES (?, ?, ?, ?)`, [okumaBatchId, itemId, userId, count], function (e, r) {
            if (e) return reject(e);
            db.get(`SELECT
                        i.id, u.id, u.name, i.count,
                        CAST(strftime('%s', i.ts) AS int) AS ts
                      FROM okuma_batch_items AS i
                      INNER JOIN users as u ON u.id = i.user_id

                      WHERE i.id = ?
                      ORDER BY i.ts
                      `, [this.lastID], function (e, r) {
              if (e) return reject(e);
              // console.log(r);
              // compile whole item here
              const history = {
                id: r.id,
                user: {id: userId, name: r.name},
                count: r.count,
                ts: r.ts,
                itemId,
              };
              const item = {
                id: itemId,
                name: itemName,
                count: totalCount,
                recommendedPortion: itemRP,
                currentCount: currentCount+count,
                history: [],
              }
              resolve([item, history]);
              db.run(`
                UPDATE okuma_batches
                    SET end_ts = CASE WHEN (SELECT sum(distinct oi.count) > sum(obi.count)
                                              FROM okumalar o
                                              INNER JOIN okuma_items oi
                                                ON oi.okuma_id = o.id
                                              INNER JOIN okuma_batches ob
                                                ON ob.okuma_id = o.id AND ob.end_ts is null
                                              LEFT JOIN okuma_batch_items AS obi
                                                ON obi.okuma_batch_id = ob.id AND obi.okuma_item_id = oi.id
                                              WHERE ob.id = ?)
                                        THEN NULL
                                      ELSE
                                        DATETIME(?, 'unixepoch') -- CURRENT_TIMESTAMP
                                  END
                  WHERE id = ?`, [okumaBatchId, r.ts, okumaBatchId], (e, r) => {
                if (e) return reject(e);
                resolve(this.changes);
              });

              emitResponse([item, history]);
            });
          });
        });

        const emitResponse = r => {
          const [item, history] = r;
          io.emit('got-okuma', item, history);
          console.debug(`[got-okuma]:io.emit(${JSON.stringify(item)}, ${JSON.stringify(history)})`);
          callback(item, history);
        };

        if (okumaBatchId) {
          const currentCount = rows.reduce((s, a) => s+a.obicount, 0);
          checkCurrentCount(currentCount);
          createHistoryAndResponse(okumaBatchId, currentCount);
        } else {
          db.run(`INSERT INTO okuma_batches(okuma_id) VALUES (?)`, [okumaId], function (e, r) {
            if (e) throw e;
            checkCurrentCount(0);
            createHistoryAndResponse(this.lastID, 0);
          });
        }
      });


      // db.get(`SELECT id, is_active, name FROM users WHERE id = ?`, [userId], (e, user) => {
      //   if (e) throw e;
      //   for (let item of okumalar.items) {
      //     for (let subitem of item.subitems) {
      //       if (subitem.id === subitemId) {
      //         subitem.currentCount = (subitem.currentCount || 0) + count;
      //         const okumaHistory = {id: okumaHistoryId++, user, count, ts: Date.now()/1000, subitemId};
      //         item.history = [...(item.history || []), okumaHistory];
      //         io.emit('got-okuma', subitem, okumaHistory);
      //         console.debug(`[got-okuma]:emit(${JSON.stringify(subitem)}, ${JSON.stringify(okumaHistory)})`)
      //         callback(subitem, okumaHistory);
      //         return;
      //       }
      //     }
      //   }
      // });

    })
  });
});


server.listen(port, () => console.log(`Server is listening on port ${port}`));
