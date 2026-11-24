# Redirect numbertools.io → numbertools.eu

Use after `numbertools.eu` is live on Hostinger and subdomains resolve.

## Per-subdomain `.htaccess` (Apache)

Place in the **old** `.io` docroot (example: vocabulary):

```apache
RewriteEngine On
RewriteCond %{HTTP_HOST} ^(www\.)?vocabulary\.numbertools\.io$ [NC]
RewriteRule ^(.*)$ https://vocabulary.numbertools.eu/$1 [R=301,L]
```

Speaking (if you later create `speaking.numbertools.io`):

```apache
RewriteEngine On
RewriteCond %{HTTP_HOST} ^(www\.)?speaking\.numbertools\.io$ [NC]
RewriteRule ^(.*)$ https://speaking.numbertools.eu/$1 [R=301,L]
```

Apex / path-based speaking on main domain:

```apache
RewriteEngine On
# Prefer keeping apex content; only redirect /speaking if you move it fully
RewriteRule ^speaking(?:/(.*))?$ https://speaking.numbertools.eu/$1 [R=301,L]
```

## hPanel alternative

**Websites → domain → Redirects** → permanent 301 from each `.io` host to the matching `.eu` URL.
