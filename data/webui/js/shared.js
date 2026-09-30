// The modules share one private namespace for their intentionally coupled UI
// state and callbacks. It is an imported value, never a Window interface.
export const ctx = Object.create(null);
