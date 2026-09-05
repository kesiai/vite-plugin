import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutDashboardIcon, TerminalSquareIcon, UsersIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Toaster, toast } from '@/components/ui/toast';
import { nodeApi, addChildToPageRoot } from './editorApi';
import { decodeNodeId } from './decodeNodeId';
import PageView from './PageView';
import ApiConsole from './ApiConsole';
import PropPanel from './PropPanel';
import Dashboard from '../pages/dashboard/Dashboard';
import Users from '../pages/users/Users';

// ===== react-router 路由配置（页面下拉列表的数据来源） =====
interface AppRoute {
  path: string;
  label: string;
  file: string; // /__editor API 使用的页面相对路径
  icon: typeof LayoutDashboardIcon;
}

const APP_ROUTES: AppRoute[] = [
  { path: '/dashboard', label: '总览', file: 'dashboard/Dashboard', icon: LayoutDashboardIcon },
  { path: '/users', label: '用户', file: 'users/Users', icon: UsersIcon },
  { path: '/api', label: 'API', file: 'api', icon: TerminalSquareIcon },
];

interface SelInfo {
  id: string;
  label: string;
  sub?: string;
}

interface BoxRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function App() {

  return (
    <div className="flex h-screen bg-muted/40 text-foreground p-4">
      {/* ===== 右侧（react-router 路由出口） ===== */}
      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/users" element={<Users />} />
          <Route
            path="/api"
            element={
              <div className="h-full p-4">
                <ApiConsole />
              </div>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

      <Toaster />
    </div>
  );
}
