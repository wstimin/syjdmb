'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { api } from '@/lib/api';

type GeneralSettings = {
  appName: string;
  supportEmail: string;
  siteUrl: string;
  cardPurchaseUrl: string;
  showWechat: boolean;
  showAlipay: boolean;
  showCard: boolean;
  showBalance: boolean;
  wechatEnabled: boolean;
  alipayEnabled: boolean;
};

const SettingsContext = createContext<GeneralSettings>({
  appName: 'NodeShop',
  supportEmail: '',
  siteUrl: '',
  cardPurchaseUrl: '',
  showWechat: true,
  showAlipay: true,
  showCard: true,
  showBalance: true,
  wechatEnabled: false,
  alipayEnabled: false,
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GeneralSettings>({
    appName: 'NodeShop',
    supportEmail: '',
    siteUrl: '',
    cardPurchaseUrl: '',
    showWechat: true,
    showAlipay: true,
    showCard: true,
    showBalance: true,
    wechatEnabled: false,
    alipayEnabled: false,
  });

  useEffect(() => {
    api
      .get('/system/general')
      .then((res) => {
        const d = res.data?.data;
        if (d) setSettings(d);
      })
      .catch(() => {
        // 静默失败：使用默认值，不阻断页面
      });
  }, []);

  // 动态更新页面标题
  useEffect(() => {
    document.title = `${settings.appName} - 国际网络连接服务`;
  }, [settings.appName]);

  return (
    <SettingsContext.Provider value={settings}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => useContext(SettingsContext);
