import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('API boundary', () => {
  it('preserves conflict and request ID without retrying a mutation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'BOOKING_CONFLICT', message: 'Seat taken', request_id: 'r-1' }),
          { status: 409 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(apiRequest('/bookings', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 409,
      problem: { code: 'BOOKING_CONFLICT', request_id: 'r-1' },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/bookings')
    expect(fetch.mock.calls[0][1].credentials).toBe('omit')
  })
  it('does not expose an HTML proxy error as a user message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('<html>private upstream detail</html>', { status: 502 })),
    )
    await expect(apiRequest('/health/ready')).rejects.toMatchObject({
      status: 502,
      problem: { code: 'HTTP_ERROR' },
    })
  })
  it('keeps caller cancellation distinct from offline errors', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(controller.signal.reason))
    await expect(apiRequest('/health/ready', { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    )
  })
  it('maps a connection failure and rejects external request paths', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('private network details'))
    vi.stubGlobal('fetch', fetch)
    await expect(apiRequest('/health/ready')).rejects.toMatchObject({
      status: 0,
      problem: { code: 'NETWORK_ERROR' },
    })
    await expect(apiRequest('//other.example')).rejects.toThrow('relative')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
