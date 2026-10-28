// The words LightMoon says when a reminder goes off, e.g. "Boss, you have a meeting at 5 o'clock."
// Shared by the app and the service worker (which can't use the app's storage module).

// How the user likes to be addressed: "sir", "ma'am", "boss", or their name. `settings` uses the stored keys.
export function addressWord(settings = {}) {
  const address = settings.address || 'sir';
  return address === 'name' ? settings.user_name || 'friend' : address;
}

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// The sentence the AI wrote when the reminder was set, or a plain one if it didn't write one.
export function reminderLine(task, settings) {
  return task.announce || `${capitalize(addressWord(settings))}, it's time: ${task.title}.`;
}
