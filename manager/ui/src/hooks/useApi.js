/**
 * useApi - Centralized API fetch hook with error handling
 *
 * Provides consistent error handling, loading states, and auth header injection
 * for all API calls across the application.
 */

import { useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * API error class with structured error info
 */
export class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Parse error response from API
 */
async function parseErrorResponse(response) {
  try {
    const data = await response.json();
    return data.error || data.message || `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

/**
 * Hook for making API requests with consistent error handling
 *
 * @returns {Object} API utilities
 */
export function useApi() {
  const { getAuthHeader, logout } = useAuth();

  /**
   * Make an authenticated API request
   *
   * @param {string} url - API endpoint
   * @param {Object} [options] - Fetch options
   * @returns {Promise<any>} Response data
   * @throws {ApiError} On request failure
   */
  const request = useCallback(async (url, options = {}) => {
    const headers = {
      ...getAuthHeader(),
      ...options.headers,
    };

    // Add Content-Type for JSON bodies
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, { ...options, headers });

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
      return null;
    }

    return response.json();
  }, [getAuthHeader, logout]);

  /**
   * GET request
   */
  const get = useCallback((url, options = {}) => {
    return request(url, { ...options, method: 'GET' });
  }, [request]);

  /**
   * POST request
   */
  const post = useCallback((url, body, options = {}) => {
    return request(url, { ...options, method: 'POST', body });
  }, [request]);

  /**
   * PUT request
   */
  const put = useCallback((url, body, options = {}) => {
    return request(url, { ...options, method: 'PUT', body });
  }, [request]);

  /**
   * DELETE request
   */
  const del = useCallback((url, options = {}) => {
    return request(url, { ...options, method: 'DELETE' });
  }, [request]);

  return { request, get, post, put, del };
}

/**
 * Hook for fetching data with loading/error states
 *
 * @param {Function} fetchFn - Async function that fetches data
 * @param {Object} [options]
 * @param {boolean} [options.immediate=false] - Fetch immediately on mount
 * @returns {Object} { data, loading, error, refetch }
 */
export function useFetch(fetchFn, { immediate = false } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);

  const execute = useCallback(async (...args) => {
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
      if (process.env.NODE_ENV !== 'production') {
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

  const get = useCallback((path, options) => {
    return api.get(`/api/admin${path}`, options);
  }, [api]);

  const post = useCallback((path, body, options) => {
    return api.post(`/api/admin${path}`, body, options);
  }, [api]);

  const put = useCallback((path, body, options) => {
    return api.put(`/api/admin${path}`, body, options);
  }, [api]);

  const del = useCallback((path, options) => {
    return api.del(`/api/admin${path}`, options);
  }, [api]);

  return { get, post, put, del };
}

export default useApi;
