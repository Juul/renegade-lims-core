
This library provides the database and replication capability for [renegade-lims](https://github.com/renegadebio/renegade-lims).

# Usage

```
const limsCore = require('renegade-lims-core');

limsCore.init(db, opts, function(err, core) {

  // core.adminCore: A kappa-core instance containing e.g. user data
  // core.labCore: A kappa-core instance containing e.g. lab inventory data
  
  // core.adminMulti: Multifeed instance used by adminCore
  // core.labMulti: Multifeed instance used by labCore
  
});
```

`db` is a levelup or subleveldown instance.

The `opts` is simply the `settings.js` which is explained by the `settings.js.example` file in the main renegade-lims repository.

All database views are created using `kappa-view` and are located `views/`.

As an optional fourth argument you can add a callback which is called whenever a client has successfully connected. Received arguments are `peer` (the peer from settings.js), `peerDesc` which has peer type, host and port, and `socket`.

# Copyright and license

* Copyright 2020 renegade.bio
* License: AGPLv3

See the `LICENSE` file for full license.