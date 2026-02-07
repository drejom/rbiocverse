/**
 * useApi - Centralized API fetch hook with error handling
 *
 * Provides consistent error handling, loading states, and auth header injection
 * for all API calls across the application.
 */

import { useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * API error class with structured error info
 */
export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Parse error response from API
 */
async function parseErrorResponse(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return data.error || data.message || `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

/**
 * Hook for making API requests with consistent error handling
 */
export function useApi() {
  const { getAuthHeader, logout } = useAuth();

  /**
   * Make an authenticated API request
   */
  const request = useCallback(async <T = unknown>(url: string, options: RequestOptions = {}): Promise<T> => {
    const headers: Record<string, string> = {
      ...getAuthHeader(),
      ...options.headers,
    };

    let body = options.body;
    // Add Content-Type for JSON bodies
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const response = await fetch(url, { ...options, headers, body: body as BodyInit | undefined });

    // Handle auth errors
    if (response.status === 401) {
      logout();
      throw new ApiError('Session expired. Please log in again.', 401);
    }

    // Handle other errors
    if (!response.ok) {
      const errorMessage = await parseErrorResponse(response);
      throw new ApiError(errorMessage, response.status);
    }

    // Handle empty responses
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return null as T;
    }

    return response.json();
  }, [getAuthHeader, logout]);

  /**
   * GET request
   */
  const get = useCallback(<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> => {
    return request<T>(url, { ...options, method: 'GET' });
  }, [request]);

  /**
   * POST request
   */
  const post = useCallback(<T = unknown>(url: string, body?: unknown, options: RequestOptions = {}): Promise<T> => {
    return request<T>(url, { ...options, method: 'POST', body });
  }, [request]);

  /**
   * PUT request
   */
  const put = useCallback(<T = unknown>(url: string, body?: unknown, options: RequestOptions = {}): Promise<T> => {
    return request<T>(url, { ...options, method: 'PUT', body });
  }, [request]);

  /**
   * DELETE request
   */
  const del = useCallback(<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> => {
    return request<T>(url, { ...options, method: 'DELETE' });
  }, [request]);

  return { request, get, post, put, del };
}

interface UseFetchOptions {
  immediate?: boolean;
}

interface UseFetchReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  execute: (...args: unknown[]) => Promise<T>;
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Hook for fetching data with loading/error states
 */
export function useFetch<T>(
  fetchFn: (...args: unknown[]) => Promise<T>,
  { immediate = false }: UseFetchOptions = {}
): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (...args: unknown[]): Promise<T> => {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchFn(...args);
      setData(result);
      return result;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'An unexpected error occurred';
      setError(message);
      // Log to console for debugging, but don't expose internals to user
      if (import.meta.env.DEV) {
        console.error('Fetch error:', err);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [fetchFn]);

  return { data, loading, error, execute, setData };
}

/**
 * Hook for admin API requests (adds /api/admin prefix)
 */
export function useAdminApi() {
  const api = useApi();

  const get = useCallback(<T = unknown>(path: string, options?: RequestOptions): Promise<T> => {
    return api.get<T>(`/api/admin${path}`, options);
  }, [api]);

  const post = useCallback(<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => {
    return api.post<T>(`/api/admin${path}`, body, options);
  }, [api]);

  const put = useCallback(<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => {
    return api.put<T>(`/api/admin${path}`, body, options);
  }, [api]);

  const del = useCallback(<T = unknown>(path: string, options?: RequestOptions): Promise<T> => {
    return api.del<T>(`/api/admin${path}`, options);
  }, [api]);

  return { get, post, put, del };
}

export default useApi;
