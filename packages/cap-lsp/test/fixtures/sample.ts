export function greet(name: string): string {
  return `hello ${name}`;
}

const message = greet("world");
console.log(message);
