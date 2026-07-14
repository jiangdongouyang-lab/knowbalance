declare function identityAny(value: any): any;
declare const resultAny: any;
declare const numAny: any;
declare function identityString(value: string): string;
declare function identityNumber(value: number): number;
declare function identity<T>(value: T): T;
declare const genericString = "hello";
declare const genericNumber = 42;
declare const genericBoolean = true;
declare function firstElement<T>(arr: T[]): T | undefined;
declare const numbers: number[];
declare const strings: string[];
declare const firstNum: number | undefined;
declare const firstStr: string | undefined;
declare function firstElementAny(arr: any[]): any;
declare const lostNum: any;
interface HasLength {
    length: number;
}
declare function logLength<T extends HasLength>(value: T): void;
declare function pair<A, B>(first: A, second: B): [A, B];
declare const myPair: [string, number];
declare const myPair2: [number, boolean];
declare function swap<T, U>(a: T, b: U): [U, T];
declare const swapped: [number, string];
interface Container<T> {
    value: T;
    getValue(): T;
}
declare class Box<T> implements Container<T> {
    value: T;
    constructor(value: T);
    getValue(): T;
}
declare const stringBox: Box<string>;
declare const numberBox: Box<number>;
interface User {
    id: number;
    name: string;
    email: string;
}
declare function updateUser(user: User, updates: Partial<User>): User;
declare const frozenArray: ReadonlyArray<string>;
interface ApiResponse<T> {
    data: T;
    status: number;
    message: string;
}
interface UserData {
    id: number;
    name: string;
    email: string;
}
interface Product {
    id: number;
    title: string;
    price: number;
}
declare function getUser(): Promise<ApiResponse<UserData>>;
declare function getProduct(): Promise<ApiResponse<Product>>;
