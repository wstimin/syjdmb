'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import axios from 'axios';

export const API_URL = '/api';

export const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

export function getErrorMessage(err: any): string {
  const data = err?.response?.data;
  if (data?.message) return Array.isArray(data.message) ? data.message.join(', ') : data.message;
  return err?.message || 'Something went wrong';
}

interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  role: string;
}

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Partial<AdminUser>>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    const { accessToken, refreshToken, user: u } = res.data.data;
    localStorage.setItem('adminToken', accessToken);
    localStorage.setItem('adminRefresh', refreshToken);
    setUser(u);
    return u;
  };

  const logout = async () => {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminRefresh');
    setUser(null);
  };

  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      setLoading(false);
      return;
    }
    api.get('/auth/profile', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => setUser(res.data.data))
      .catch(() => { localStorage.removeItem('adminToken'); localStorage.removeItem('adminRefresh'); })
      .finally(() => setLoading(false));
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('adminToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refreshToken = localStorage.getItem('adminRefresh');
      if (refreshToken) {
        try {
          const res = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
          const { accessToken, refreshToken: newRefresh } = res.data.data;
          localStorage.setItem('adminToken', accessToken);
          localStorage.setItem('adminRefresh', newRefresh);
          original.headers.Authorization = `Bearer ${accessToken}`;
          return api(original);
        } catch { /* ignore */ }
      }
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminRefresh');
    }
    return Promise.reject(error);
  }
);
