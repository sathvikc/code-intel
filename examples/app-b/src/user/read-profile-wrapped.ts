// Reader for the shape-drift single-hop chain follow fixture.
//
// Wraps the JSON.parse(getItem) in a helper function. The analyzer
// should follow the return value to the caller and see that 'first_name'
// and 'last_name' are accessed, causing a drift finding against the writer
// in app-a which writes 'firstName' and 'lastName'.

interface CachedProfile {
  first_name: string;
  last_name: string;
}

function getProfileFromCache(): CachedProfile {
  return JSON.parse(localStorage.getItem('user.profile') || '{}');
}

export function renderWrappedGreeting(): string {
  const profile = getProfileFromCache();
  return `Hello, ${profile.first_name} ${profile.last_name}`;
}
