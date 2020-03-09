# apif-stat

A sample stat generator for API Fortress.

Given an API Fortress API-Hook and a time range, this program will generate aggregated statistics for it.

Example:

```sh
node main.js create -s 2020/01/01 -e 2020/02/01 -k https://apifortress.example.com/app/api/rest/v3/abc123-abc123 -T basic.mustache -o output.html
```
