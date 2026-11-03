'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rainbrush', {
  /* ---- Farmers ---- */
  listFarmers:  ()      => ipcRenderer.invoke('farmers:list'),
  getFarmer:    (id)    => ipcRenderer.invoke('farmers:get', id),
  addFarmer:    (f)     => ipcRenderer.invoke('farmers:insert', f),
  updateFarmer: (f)     => ipcRenderer.invoke('farmers:update', f),
  removeFarmer: (id)    => ipcRenderer.invoke('farmers:remove', id),
  farmerAlerts: (id)    => ipcRenderer.invoke('farmers:alertHistory', id),

  /* ---- Alerts ---- */
  saveAlerts:   (list)  => ipcRenderer.invoke('alerts:saveBatch', list),
  recentAlerts: (n)     => ipcRenderer.invoke('alerts:recent', n),
  sentSignatures: ()    => ipcRenderer.invoke('alerts:sentSignatures', 500),
  isSignatureSent:(sig) => ipcRenderer.invoke('alerts:isSent', sig),

  /* ---- Stats ---- */
  getStats:     ()       => ipcRenderer.invoke('stats:get'),
  bumpStat:     (key, n) => ipcRenderer.invoke('stats:bump', { key, by: n }),

  /* ---- SMS ---- */
  smsInfo:       ()      => ipcRenderer.invoke('sms:info'),
  smsTest:       (to)    => ipcRenderer.invoke('sms:test', { to }),
  smsSendBatch:  (jobs)  => ipcRenderer.invoke('sms:sendBatch', jobs),
  smsOpenLog:    ()      => ipcRenderer.invoke('sms:openLog'),
  onSmsProgress: (fn)    => ipcRenderer.on('sms:progress', (_e, p) => fn(p)),
  offSmsProgress:()      => ipcRenderer.removeAllListeners('sms:progress'),

  /* ---- Voice ---- */
  voiceInfo:       ()       => ipcRenderer.invoke('voice:info'),
  voiceTest:       (to, t)  => ipcRenderer.invoke('voice:test', { to, text: t }),
  voiceEstimate:   (t, c)   => ipcRenderer.invoke('voice:estimate', { text: t, country: c }),
  voiceDispatch:   (jobs)   => ipcRenderer.invoke('voice:dispatch', jobs),
  voiceRecent:     (n)      => ipcRenderer.invoke('voice:recent', n),
  voiceStatusMap:  ()       => ipcRenderer.invoke('voice:statusMap'),
  voiceSummary:    ()       => ipcRenderer.invoke('voice:summary'),
  voicePollStatus: ()       => ipcRenderer.invoke('voice:pollStatus'),
  voiceOpenLog:    ()       => ipcRenderer.invoke('voice:openLog'),
  onVoiceProgress: (fn)     => ipcRenderer.on('voice:progress', (_e, p) => fn(p)),

  /* ---- Delivery receipts ---- */
  receiptsSummary:   ()     => ipcRenderer.invoke('receipts:summary'),
  receiptsRecent:    (n)    => ipcRenderer.invoke('receipts:recent', n),
  receiptsStatusMap: ()     => ipcRenderer.invoke('receipts:statusMap'),
  receiptsEvents:    (sig)  => ipcRenderer.invoke('receipts:events', sig),
  receiptsStats:     ()     => ipcRenderer.invoke('receipts:stats'),
  receiptsPoll:      ()     => ipcRenderer.invoke('receipts:poll'),
  receiptsRetry:     (sig)  => ipcRenderer.invoke('receipts:retry', sig),
  receiptsOpenLog:   ()     => ipcRenderer.invoke('receipts:openLog'),
  onReceiptsUpdate:  (fn)   => ipcRenderer.on('receipts:updated', (_e, info) => fn(info)),

  /* ---- Scheduler ---- */
  schedulerStatus:      ()      => ipcRenderer.invoke('scheduler:status'),
  schedulerRunNow:      ()      => ipcRenderer.invoke('scheduler:runNow'),
  schedulerSetEnabled:  (on)    => ipcRenderer.invoke('scheduler:setEnabled', on),
  schedulerSetInterval: (hrs)   => ipcRenderer.invoke('scheduler:setInterval', hrs),
  schedulerSetAutoSend: (on)    => ipcRenderer.invoke('scheduler:setAutoSend', on),
  schedulerOpenLog:     ()      => ipcRenderer.invoke('scheduler:openLog'),
  onSchedulerCycle:     (fn)    => ipcRenderer.on('scheduler:cycle-complete', (_e, info) => fn(info)),

  /* ---- USSD relay ---- */
  ussdInfo:       ()      => ipcRenderer.invoke('ussd:info'),
  ussdSync:       ()      => ipcRenderer.invoke('ussd:sync'),
  ussdHealth:     ()      => ipcRenderer.invoke('ussd:health'),
  ussdSessions:   (n)     => ipcRenderer.invoke('ussd:sessions', n),
  ussdAnalytics:  (since) => ipcRenderer.invoke('ussd:analytics', since),
  ussdOpenLog:    ()      => ipcRenderer.invoke('ussd:openLog'),

  /* ---- CSV import ---- */
  csvPickFile:       ()  => ipcRenderer.invoke('csv:pickFile'),
  csvExportTemplate: ()  => ipcRenderer.invoke('csv:exportTemplate'),
  addFarmersBatch:   (l) => ipcRenderer.invoke('farmers:insertBatch', l),

  /* ---- Native ---- */
  notify:       (n)    => ipcRenderer.invoke('notify', n),
  exportCSV:    (o)    => ipcRenderer.invoke('export:csv', o),
  showInFolder: (p)    => ipcRenderer.invoke('export:showInFolder', p),

  /* ---- App info ---- */
  appInfo:      ()     => ipcRenderer.invoke('app:info'),
  revealData:   ()     => ipcRenderer.invoke('app:revealData'),

  /* ---- Tray → renderer ---- */
  onTrayRefresh:   (fn) => ipcRenderer.on('trigger-refresh',   () => fn()),
  onTrayBroadcast: (fn) => ipcRenderer.on('trigger-broadcast', () => fn()),

  isDesktop: true
});