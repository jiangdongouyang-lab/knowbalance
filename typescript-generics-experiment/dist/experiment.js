"use strict";
// TypeScript Generics Basics Experiment
// =====================================
// Part 1: The Problem with `any`
// =====================================
// Example 1: Using `any` - type safety is lost
function identityAny(value) {
    return value;
}
const resultAny = identityAny("hello"); // type is `any`
const numAny = identityAny(42); // type is `any`
// PROBLEM: TypeScript doesn't know what type you'll get back!
// We lose all type safety and autocompletion.
// Example 2: Without generics, we'd need type assertions
function identityString(value) {
    return value;
}
function identityNumber(value) {
    return value;
}
// This is repetitive and doesn't scale.
// Part 2: Generics - The Solution
// =====================================
// Example 3: Using generics (the "type parameter" T)
function identity(value) {
    return value;
}
// TypeScript infers T from the argument
const genericString = identity("hello"); // T is inferred as string
const genericNumber = identity(42); // T is inferred as number
const genericBoolean = identity(true); // T is inferred as boolean
// Now TypeScript knows the exact type!
// genericString.toUpperCase() ✅ Works!
// genericNumber.toUpperCase() ❌ Error: number doesn't have toUpperCase
// Part 3: Generics in Practice - Array Operations
// =====================================
// Example 4: First element of an array
function firstElement(arr) {
    return arr[0];
}
const numbers = [1, 2, 3];
const strings = ["a", "b", "c"];
const firstNum = firstElement(numbers); // type: number
const firstStr = firstElement(strings); // type: string
// firstNum.toUpperCase() ❌ Error (as expected!)
// firstStr.toUpperCase() ✅ Works!
// Example 5: Without generics, we'd need separate functions
function firstElementAny(arr) {
    return arr[0];
}
// This loses type information completely
const lostNum = firstElementAny(numbers); // type: any
function logLength(value) {
    console.log(`Length: ${value.length}`);
}
logLength("hello"); // ✅ string has length
logLength([1, 2, 3]); // ✅ array has length
logLength({ length: 10 }); // ✅ object with length property
// logLength(42);             // ❌ number doesn't have length
// Part 5: Multiple Type Parameters
// =====================================
// Example 7: Generic function with two type parameters
function pair(first, second) {
    return [first, second];
}
const myPair = pair("hello", 42); // type: [string, number]
const myPair2 = pair(1, true); // type: [number, boolean]
// Example 8: Swapping elements
function swap(a, b) {
    return [b, a];
}
const swapped = swap("hello", 42); // type: [number, string]
// Example 10: Generic class
class Box {
    constructor(value) {
        this.value = value;
    }
    getValue() {
        return this.value;
    }
}
const stringBox = new Box("hello"); // Box<string>
const numberBox = new Box(42); // Box<number>
console.log(stringBox.getValue()); // "hello"
console.log(numberBox.getValue()); // 42
function updateUser(user, updates) {
    return { ...user, ...updates };
}
// All fields are optional in updates
updateUser({ id: 1, name: "Alice", email: "alice@example.com" }, {
    name: "Bob" // Only updating name
});
// Example 12: Readonly
const frozenArray = ["a", "b", "c"];
// These are typed correctly!
function getUser() {
    return Promise.resolve({
        data: { id: 1, name: "Alice", email: "alice@example.com" },
        status: 200,
        message: "OK"
    });
}
function getProduct() {
    return Promise.resolve({
        data: { id: 100, title: "Laptop", price: 999 },
        status: 200,
        message: "OK"
    });
}
// The types flow through correctly
getUser().then(response => {
    console.log(response.data.name); // ✅ TypeScript knows this is UserData
    console.log(response.data.email); // ✅ UserData has email property
    // console.log(response.data.title);  // ❌ Error: UserData doesn't have title
});
getProduct().then(response => {
    console.log(response.data.title); // ✅ TypeScript knows this is Product
    console.log(response.data.price); // ✅ Product has price property
    // console.log(response.data.name);   // ❌ Error: Product doesn't have name
});
// Summary
// =====================================
console.log("\n=== Key Takeaways ===");
console.log("1. `any` loses type information - avoid it!");
console.log("2. Generics preserve type information");
console.log("3. Use <T> to create type parameters");
console.log("4. TypeScript infers types from arguments");
console.log("5. Use constraints (extends) when needed");
console.log("6. Generics work with interfaces, classes, and functions");
//# sourceMappingURL=experiment.js.map