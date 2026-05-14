Debug files created after the direct function-calling refactor should use this shape:

1. User input
2. System instruction sent to Gemini
3. Registered tool/function declarations sent to Gemini
4. Gemini raw function call output
5. Function call selected by Gemini
6. Executed app function
7. Function result
8. Retail product lookup sources, when lookup_store_product is used

There is no extra legacy adapter layer anymore. The backend executes the returned function call directly.
