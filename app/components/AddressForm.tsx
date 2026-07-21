/**
 * International address form with country-specific field order and labels.
 */

import type React from "react";
import { FormLayout, Select, TextField } from "@shopify/polaris";
import {
  getCountryOptions,
  getAddressLabels,
  getAddressFieldOrder,
  getProvinceOptions,
} from "../lib/address";
import "../styles/address-form.css";

/** Must live at module scope: defining it inside the render creates a new
 * component type on every keystroke, remounting fields and dropping focus. */
function GridRow({ children }: { children: React.ReactNode }) {
  return <div className="address-form__row">{children}</div>;
}

export interface AddressFormProps {
  countryCode: string;
  onCountryChange: (value: string) => void;
  address1: string;
  onAddress1Change: (value: string) => void;
  address2?: string;
  onAddress2Change?: (value: string) => void;
  city: string;
  onCityChange: (value: string) => void;
  provinceCode: string;
  onProvinceCodeChange: (value: string) => void;
  zip: string;
  onZipChange: (value: string) => void;
  /** Render in 2-column grid for compact layout */
  columns?: 1 | 2;
  /** Hide country select (use when parent renders it separately) */
  hideCountry?: boolean;
}

export function AddressForm({
  countryCode,
  onCountryChange,
  address1,
  onAddress1Change,
  address2,
  onAddress2Change,
  city,
  onCityChange,
  provinceCode,
  onProvinceCodeChange,
  zip,
  onZipChange,
  columns = 1,
  hideCountry = false,
}: AddressFormProps) {
  const labels = getAddressLabels(countryCode);
  const fieldOrder = getAddressFieldOrder(countryCode);
  const countryOptions = getCountryOptions();
  const provinceOptions = getProvinceOptions(countryCode);
  const isGrid = columns === 2;

  const address1Field = (
    <TextField
      key="address1"
      label={labels.address1}
      value={address1}
      onChange={onAddress1Change}
      autoComplete="street-address"
    />
  );

  const cityField = (
    <TextField
      key="city"
      label={labels.city}
      value={city}
      onChange={onCityChange}
      autoComplete="address-level2"
    />
  );

  const provinceField =
    provinceOptions.length > 0 ? (
      <Select
        key="province"
        label={labels.province}
        options={[{ label: "Select", value: "" }, ...provinceOptions]}
        value={provinceCode || ""}
        onChange={onProvinceCodeChange}
      />
    ) : (
      <TextField
        key="province"
        label={labels.province}
        value={provinceCode}
        onChange={onProvinceCodeChange}
        autoComplete="address-level1"
      />
    );

  const zipField = (
    <TextField
      key="zip"
      label={labels.zip}
      value={zip}
      onChange={onZipChange}
      autoComplete="postal-code"
    />
  );

  const address2Field =
    onAddress2Change != null ? (
      <TextField
        key="address2"
        label="Address line 2"
        value={address2 ?? ""}
        onChange={onAddress2Change}
        autoComplete="address-line2"
      />
    ) : null;

  const addressFields =
    fieldOrder === "eastern"
      ? [zipField, provinceField, cityField, address1Field, address2Field].filter(Boolean)
      : [address1Field, address2Field, cityField, provinceField, zipField].filter(Boolean);

  const countrySelect = (
    <Select
      label="Country"
      options={countryOptions}
      value={countryCode}
      onChange={onCountryChange}
    />
  );

  if (isGrid) {
    const countryZipRow = !hideCountry && (
      <GridRow>
        <div className="address-form__cell">{countrySelect}</div>
        <div className="address-form__cell">{zipField}</div>
      </GridRow>
    );
    return (
      <div className="address-form address-form--grid">
        {fieldOrder === "eastern" ? (
          <>
            {countryZipRow}
            <GridRow>
              <div className="address-form__cell">{provinceField}</div>
              <div className="address-form__cell">{cityField}</div>
            </GridRow>
            <GridRow>
              <div className="address-form__cell">{address1Field}</div>
              <div className="address-form__cell">{address2Field ?? <div />}</div>
            </GridRow>
            {hideCountry && (
              <GridRow>
                <div className="address-form__cell">{zipField}</div>
              </GridRow>
            )}
          </>
        ) : (
          <>
            {countryZipRow}
            <GridRow>
              <div className="address-form__cell">{address1Field}</div>
              <div className="address-form__cell">{address2Field ?? <div />}</div>
            </GridRow>
            <GridRow>
              <div className="address-form__cell">{cityField}</div>
              <div className="address-form__cell">{provinceField}</div>
            </GridRow>
            {hideCountry && (
              <GridRow>
                <div className="address-form__cell">{zipField}</div>
              </GridRow>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <FormLayout>
      {countrySelect}
      {addressFields}
    </FormLayout>
  );
}
