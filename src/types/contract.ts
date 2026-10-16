/**
 * Plain-data view of a Typra-generated model class: its JSON properties,
 * recursively, without methods or the `additionalProperties` passthrough bag.
 * Optional properties also accept `null`, which every runtime loads like an
 * absent key. Document types in `src/types` derive from it so the contract
 * stays the source of truth; refinements may only narrow it.
 */
export type ContractData<T> = {
  [K in keyof T as K extends "additionalProperties"
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? never
      : K]: ContractValue<T[K]> | (undefined extends T[K] ? null : never);
};

type ContractValue<V> = V extends readonly (infer E)[]
  ? ContractValue<E>[]
  : V extends object
    ? ContractData<V>
    : V;
