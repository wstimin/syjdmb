'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Save, Eye, EyeOff, Cable } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  socks: any; // 来自 /socks-panel/mine 的节点台账行
  open: boolean;
  onClose: () => void;
  onDone: () => void; // 修改成功后刷新节点列表
}

/** SOCKS 节点修改弹窗：可修改备注（remark）与连接认证信息（username/password）。
 * 后端 PATCH /socks-panel/:id —— 改认证时按 panelSnapshot 全量替换面板入站并重启 Xray。
 */
export default function EditSocksDialog({ socks, open, onClose, onDone }: Props) {
  const [remark, setRemark] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!socks) return;
    setRemark(socks.remark || '');
    setUsername(socks.username || '');
    setPassword(socks.password || '');
    setShowPass(false);
  }, [open, socks]);

  if (!socks) return null;

  const canSave = busy;

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/socks-panel/${socks.id}`, {
        remark: remark.trim() || null,
        username: username.trim() || null,
        password: password.trim() || null,
      });
      toast.success('已保存');
      onDone();
      onClose();
    } catch (err: any) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const serverName = socks.server?.name || `#${socks.serverId}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>修改 SOCKS 节点</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Cable className="h-4 w-4 text-primary" />
            {serverName} · :{socks.port}
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">备注（可选，用于区分节点）</label>
            <Input
              placeholder="如：我的台湾节点"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">用户名</label>
            <Input
              placeholder="SOCKS 认证用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">密码</label>
            <div className="relative">
              <Input
                type={showPass ? 'text' : 'password'}
                placeholder="SOCKS 认证密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            修改用户名或密码后，连接串将同步更新并在服务器上重新生效；仅改备注不触碰服务器。
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>取消</Button>
            <Button onClick={save} disabled={canSave}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}