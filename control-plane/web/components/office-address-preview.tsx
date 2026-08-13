"use client";

import { useState } from "react";

export function OfficeAddressPreview({
  initialName,
  domain,
}: {
  initialName: string;
  domain: string;
}) {
  const [name, setName] = useState(initialName);
  const hostname = name.trim()
    ? `${name.trim()}.${domain}`
    : `your-name.${domain}`;

  return (
    <>
      <p>
        <label>
          Office name{" "}
          <input
            name="officeName"
            data-testid="office-name"
            defaultValue={initialName}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </p>
      <p className="note" data-testid="office-address-preview">
        Your office will be <strong>{hostname}</strong>. It cannot be changed
        after setup.
      </p>
    </>
  );
}
