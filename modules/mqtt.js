import { MSG_TYPE, NET_PARAMS, UI_CONFIG } from './constants.js';

export function init() {
  console.log('📦 加载模块: MQTT');

  const CFG = window.config;

  window.mqtt = {
    client: null,
    failCount: 0,

    start() {
      if (typeof Paho === 'undefined') {
        window.util.log('❌ MQTT库未加载');
        setTimeout(() => this.start(), 3000);
        return;
      }

      // 决定连接参数 (支持失败自动切换代理)
      let host = CFG.mqtt.broker;
      let port = Number(CFG.mqtt.port);
      let path = CFG.mqtt.path;
      let isProxy = false;

      if (this.failCount > 0) {
        window.util.log(`🛡️ MQTT直连失败，切换代理`);
        host = CFG.mqtt.proxy_host;
        port = 443;
        path = `/https://${CFG.mqtt.broker}:${CFG.mqtt.port}${CFG.mqtt.path}`;
        isProxy = true;
      }

      const cid = "mqtt_" + window.state.myId + "_" + Math.random().toString(36).slice(2, 6);
      window.util.log(`连接MQTT: ${host}...`);
      
      this.client = new Paho.MQTT.Client(host, port, path, cid);
      window.state.mqttClient = this.client; // 暴露给 state 供检查

      // 配置回调
      this.client.onConnectionLost = (res) => this.onLost(res);
      this.client.onMessageArrived = (msg) => this.onMessage(msg);

      // 连接选项
      const opts = {
        useSSL: true,
        timeout: (this.failCount > 0 ? 10 : 5),
        onSuccess: () => this.onConnect(isProxy),
        onFailure: (ctx) => this.onFail(ctx)
      };

      try {
        this.client.connect(opts);
      } catch (e) {
        this.onFail({ errorMessage: e.message });
      }
    },

    onConnect(isProxy) {
      window.state.mqttStatus = '在线';
      this.failCount = 0;
      window.util.log(`✅ MQTT连通!`);
      if (window.ui) window.ui.updateSelf();

      this.client.subscribe(CFG.mqtt.topic);
      
      // === 关键逻辑修正：房主自动辞职 ===
      // 规则：连上MQTT后，如果不通过代理连接，且当前是房主，则辞去房主
      if (window.state.isHub && !isProxy) {
        window.util.log('⚡ 已恢复MQTT连接，正在辞去房主职务...');
        if (window.hub) window.hub.resign();
      } else {
        // 正常节点：根据 MQTT 状态巡逻或连接
        if (window.p2p) window.p2p.patrolHubs();
      }
      // ================================

      // 发送上线广播
      this.sendPresence();
      // 启动周期性广播
      if (this._pulseTimer) clearInterval(this._pulseTimer);
      this._pulseTimer = setInterval(() => this.sendPresence(), isProxy ? 10000 : 4000);
    },

    onFail(ctx) {
      window.state.mqttStatus = '失败';
      this.failCount++;
      window.util.log(`❌ MQTT失败: ${ctx.errorMessage}`);
      if (window.ui) window.ui.updateSelf();
      
      // 失败重试
      setTimeout(() => this.start(), NET_PARAMS.RETRY_DELAY);
    },

    onLost(res) {
      window.state.mqttStatus = '断开';
      this.failCount++;
      if (window.ui) window.ui.updateSelf();
      setTimeout(() => this.start(), NET_PARAMS.RETRY_DELAY);
    },

    onMessage(msg) {
      try {
        const d = JSON.parse(msg.payloadString);
        if (Math.abs(window.util.now() - d.ts) > 120000) return; // 忽略过时消息

        // 处理房主心跳
        if (d.type === MSG_TYPE.HUB_PULSE) {
          window.state.hubHeartbeats[d.hubIndex] = Date.now();
          // 如果我连接数过少，且没连这个房主，尝试连接
          if (!window.state.conns[d.id] && Object.keys(window.state.conns).length < 5) {
            if (window.p2p) window.p2p.connectTo(d.id);
          }
          return;
        }

        // 处理普通节点广播
        if (d.id === window.state.myId) return;
        
        // 如果我认识的人太少，就去连这个新人
        const count = Object.keys(window.state.conns).filter(k => window.state.conns[k].open).length;
        if (!window.state.conns[d.id] && count < 6) {
           if (window.p2p) window.p2p.connectTo(d.id);
        }

      } catch(e) {}
    },

    sendPresence() {
      if (!this.client || !this.client.isConnected()) return;

      let payload;
      if (window.state.isHub) {
        // 房主发送特殊心跳
        payload = JSON.stringify({
          type: MSG_TYPE.HUB_PULSE,
          id: window.state.myId,
          hubIndex: window.state.hubIndex,
          ts: window.util.now()
        });
      } else {
        // 普通节点发送在线信号
        payload = JSON.stringify({
          id: window.state.myId,
          ts: window.util.now()
        });
      }

      const msg = new Paho.MQTT.Message(payload);
      msg.destinationName = CFG.mqtt.topic;
      this.client.send(msg);
    }
  };
}