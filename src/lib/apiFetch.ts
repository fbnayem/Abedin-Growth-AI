import { getFirebaseIdToken } from './firebase';

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url = '';
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  }

  if (url.startsWith('/api')) {
    const token = await getFirebaseIdToken();
    if (token) {
      init = init || {};
      init.headers = {
        ...init.headers,
        'Authorization': `Bearer ${token}`
      };
    }
  }
  
  return fetch(input, init);
}
