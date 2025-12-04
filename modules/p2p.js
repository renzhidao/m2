import { MSG_TYPE, NET_PARAMS } from './constants.js';

export function init() {
  console.log('📦 加载模块: P2P');
  const CFG = window.config;

  window.p2p = {
    _searchLogShown: false,

    start() {
      if (window.state.peer && !window.state.peer.destroyed) return;
      window.util.log(`启动 P2P...`);

      try {
        const p = new Peer(window.state.myId, CFG.peer);

        p.on('open', id => {
          window.state.myId = id;
          window.state.peer = p;
          this._searchLogShown = false;
          window.util.log(`✅ 就绪: ${id.slice(0, 6)}`);
          
          if (window.ui) window.ui.updateSelf();
          
          // 启动后尝试连接所有已知房主
          this.patrolHubs();
        });

        p.on('connection', conn => this.setupConn(conn));

        p.on('error', e => {
          if (e.type === 'peer-unavailable') return; // 常见错误，忽略
          
          if (e.type === 'browser-incompatible') {
             alert('您的浏览器不支持 P2P (WebRTC)。请更换 Chrome/Edge。');
             return;
          }

          if (e.type === 'disconnected') {
             if (!this._searchLogShown) {
               window.util.log('📡 正在重连 P2P 网络...');
               this._searchLogShown = true;
             }
             p.reconnect();
             return;
          }

          // 其他网络错误，稍后重启
          if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
             setTimeout(() => this.start(), 5000);
          }
        });
      } catch (err) {
        window.util.log('❌ P2P 初始化崩溃: ' + err.message);
      }
    },

    // 主动连接别人
    connectTo(id) {
      if (!id || id === window.state.myId) return;
      if (window.state.conns[id] && window.state.conns[id].open) return;

      try {
        const conn = window.state.peer.connect(id, { reliable: true });
        conn.created = window.util.now();
        window.state.conns[id] = conn; // 先占位
        this.setupConn(conn);
      } catch (e) { }
    },

    // 配置连接事件
    setupConn(conn) {
      // 限制连接数
      const max = window.state.isHub ? NET_PARAMS.MAX_PEERS_HUB : NET_PARAMS.MAX_PEERS_NORMAL;
      if (Object.keys(window.state.conns).length >= max) {
        // 连接满了，交换一下邻居列表后礼貌挂断
        conn.on('open', () => {
          conn.send({ t: MSG_TYPE.PEER_EX, list: Object.keys(window.state.conns).slice(0, 10) });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }

      conn.on('open', () => {
        conn.lastPong = Date.now();
        conn.created = Date.now();
        window.state.conns[conn.peer] = conn;
        
        window.util.log(`🔗 连接: ${conn.peer.slice(0, 6)}`);
        
        // 握手
        const list = Object.keys(window.state.conns);
        list.push(window.state.myId);
        conn.send({ t: MSG_TYPE.HELLO, n: window.state.myName, id: window.state.myId });
        
        // 交换节点
        setTimeout(() => { if (conn.open) conn.send({ t: MSG_TYPE.PEER_EX, list: list }); }, 100);
        
        // 同步消息请求
        window.db.getRecent(1, 'all').then(m => {
            const lastTs = (m && m.length) ? m[0].ts : 0;
            setTimeout(() => {
                if(conn.open) conn.send({t: MSG_TYPE.ASK_PUB, ts: lastTs});
            }, 500);
        });

        // 触发UI更新和重试队列
        if (window.protocol) window.protocol.retryPending();
        if (window.ui) window.ui.renderList();
      });

      conn.on('data', d => this.handleData(d, conn));
      
      const onGone = () => {
        const pid = conn.peer;
        delete window.state.conns[pid];
        if (window.ui) window.ui.renderList();
      };
      conn.on('close', onGone);
      conn.on('error', onGone);
    },

    handleData(d, conn) {
      conn.lastPong = Date.now();
      if (!d || !d.t) return;

      // 基础协议处理
      if (d.t === MSG_TYPE.PING) { conn.send({ t: MSG_TYPE.PONG }); return; }
      if (d.t === MSG_TYPE.PONG) return;
      
      if (d.t === MSG_TYPE.HELLO) {
        conn.label = d.n; // 给连接打标签
        if (window.protocol) window.protocol.processIncoming({ senderId: d.id, n: d.n }); // 借用 processIncoming 更新联系人
        return;
      }

      if (d.t === MSG_TYPE.PEER_EX && Array.isArray(d.list)) {
        d.list.forEach(id => {
           if (id && id !== window.state.myId && !window.state.conns[id]) {
             // 只有连接数不满时才去连新推荐的节点
             if (Object.keys(window.state.conns).length < NET_PARAMS.MAX_PEERS_NORMAL) {
               this.connectTo(id);
             }
           }
        });
        return;
      }
      
      // 历史消息请求与响应
      if (d.t === MSG_TYPE.ASK_PUB) {
         window.db.getPublicAfter(d.ts || 0).then(list => {
             if (list.length > 0) conn.send({t: MSG_TYPE.REP_PUB, list: list});
         });
         return;
      }
      if (d.t === MSG_TYPE.REP_PUB && Array.isArray(d.list)) {
          d.list.forEach(m => {
              if (window.protocol) window.protocol.processIncoming(m);
          });
          return;
      }

      // 普通消息
      if (d.t === MSG_TYPE.MSG) {
        if (window.protocol) window.protocol.processIncoming(d, conn.peer);
      }
    },

    // 巡逻所有房主
    patrolHubs() {
      for (let i = 0; i < NET_PARAMS.HUB_COUNT; i++) {
        const targetId = NET_PARAMS.HUB_PREFIX + i;
        if (!window.state.conns[targetId] || !window.state.conns[targetId].open) {
          this.connectTo(targetId);
        }
      }
    },

    // 维护：心跳与清理
    maintenance() {
      const now = Date.now();
      
      // 清理
      Object.keys(window.state.conns).forEach(pid => {
        const c = window.state.conns[pid];
        if (!c.open && now - (c.created || 0) > NET_PARAMS.CONN_TIMEOUT) {
           delete window.state.conns[pid];
        }
        if (c.open && c.lastPong && (now - c.lastPong > NET_PARAMS.PING_TIMEOUT)) {
           // 不主动断开房主，除非超时很久
           if (!pid.startsWith(NET_PARAMS.HUB_PREFIX)) {
               c.close();
               delete window.state.conns[pid];
           }
        }
      });

      // 随机交换节点 (Gossip)
      const all = Object.keys(window.state.conns);
      if (all.length > 0) {
         const pkt = { t: MSG_TYPE.PEER_EX, list: all.slice(0, NET_PARAMS.GOSSIP_SIZE) };
         Object.values(window.state.conns).forEach(c => {
             if (c.open) {
                 c.send({ t: MSG_TYPE.PING }); // 顺便发送Ping
                 c.send(pkt);
             }
         });
      }
      
      if (window.ui) window.ui.renderList();
    }
  };
}