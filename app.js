import { NET_PARAMS, CHAT, APP_VERSION } from './modules/constants.js';

export function init() {
  console.log(`🚀 启动主程序: App Core v${APP_VERSION}`);

  window.app = {
    async init() {
      window.util.log(`正在启动 P1 v${APP_VERSION}...`);
      
      // 1. 基础环境准备
      await window.util.syncTime();
      localStorage.setItem('p1_my_id', window.state.myId);
      await window.db.init();
      
      // 2. UI 初始化
      if (window.ui && window.ui.init) window.ui.init();
      if (window.uiEvents && window.uiEvents.init) window.uiEvents.init();

      // 3. 加载初始历史消息
      this.loadHistory(20);

      // 4. 启动网络层
      if (window.p2p) window.p2p.start();
      if (window.mqtt) window.mqtt.start();

      // 5. 启动主循环
      // === 关键修复：保存 interval ID 以便后台暂停 ===
      this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
      
      // 6. 添加后台生命周期管理
      this.bindLifecycle();

      // 初始检查
      setTimeout(() => {
        if (!window.state.isHub && Object.keys(window.state.conns).length < 1) {
           if (window.state.mqttStatus === '在线') {
               if (window.p2p) window.p2p.patrolHubs();
           } else {
               if (window.hub) window.hub.connectToAnyHub();
           }
        }
      }, 2000);
    },

    // === 新增：生命周期管理 ===
    bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // 切入后台
                window.util.log('🌙 应用切入后台，暂停所有服务...');
                
                // 1. 停止 P2P (彻底销毁，释放端口)
                if (window.p2p && window.p2p.stop) window.p2p.stop();
                
                // 2. 暂停主循环 (省电 + 防止报错)
                if (this.loopTimer) {
                    clearInterval(this.loopTimer);
                    this.loopTimer = null;
                }
                
            } else {
                // 切回前台
                window.util.log('☀️ 应用切回前台，正在恢复服务...');
                
                // 1. 恢复主循环
                if (!this.loopTimer) {
                    this.loopTimer = setInterval(() => this.loop(), NET_PARAMS.LOOP_INTERVAL);
                }
                
                // 2. 重新启动 P2P (满血复活)
                if (window.p2p) window.p2p.start();
                
                // 3. 检查 MQTT (如果断了就重连)
                if (window.mqtt && (!window.mqtt.client || !window.mqtt.client.isConnected())) {
                    window.mqtt.start();
                }
                
                // 4. 强制校时
                window.util.syncTime();
            }
        });
    },

    loop() {
      // 保护：后台不运行 (虽然定时器已停，双重保险)
      if (document.hidden) return;
      
      if (window.p2p) window.p2p.maintenance();
      if (window.protocol) window.protocol.retryPending();

      if (!window.state.isHub && window.state.mqttStatus === '在线') {
         if (window.p2p) window.p2p.patrolHubs();
      } else if (!window.state.isHub && window.state.mqttStatus !== '在线') {
         if (window.hub) window.hub.connectToAnyHub();
      }
    },

    async loadHistory(limit) {
      if (window.state.loading) return;
      window.state.loading = true;
      
      const msgs = await window.db.getRecent(limit, window.state.activeChat, window.state.oldestTs);
      
      if (msgs && msgs.length > 0) {
         window.state.oldestTs = msgs[0].ts;
         msgs.forEach(m => {
            window.state.seenMsgs.add(m.id);
            if (window.ui) window.ui.appendMsg(m);
         });
      }
      window.state.loading = false;
    }
  };

  window.app.init();
}