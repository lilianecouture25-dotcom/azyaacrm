const ZIKR_KIDS_PRODUCT = {
  name: "ARCO -Athkar enfants",
  slug: "zikr-kids",
  price: 2900,
  active: true,
  variants: [
    {
      name: "Garçon / 30×40 cm",
      label: "Garçon / 30×40 cm",
      price: 2900,
      image: "https://www.image2url.com/r2/default/images/1779416607951-2d94a2df-c1a7-432a-a05b-c4f4d3cee23f.png",
      options: { Version: "Garçon", Size: "30×40 cm" },
    },
    {
      name: "Garçon / 40×60 cm",
      label: "Garçon / 40×60 cm",
      price: 3900,
      image: "https://www.image2url.com/r2/default/images/1779416607951-2d94a2df-c1a7-432a-a05b-c4f4d3cee23f.png",
      options: { Version: "Garçon", Size: "40×60 cm" },
    },
    {
      name: "Fille / 30×40 cm",
      label: "Fille / 30×40 cm",
      price: 2900,
      image: "https://www.image2url.com/r2/default/images/1779416668508-7f9a7cc8-7d2b-4203-805a-87e41a8f486f.png",
      options: { Version: "Fille", Size: "30×40 cm" },
    },
    {
      name: "Fille / 40×60 cm",
      label: "Fille / 40×60 cm",
      price: 3900,
      image: "https://www.image2url.com/r2/default/images/1779416668508-7f9a7cc8-7d2b-4203-805a-87e41a8f486f.png",
      options: { Version: "Fille", Size: "40×60 cm" },
    },
  ],
};

export function getCustomCatalogProduct(slug) {
  if (String(slug || "").toLowerCase() === ZIKR_KIDS_PRODUCT.slug) {
    return ZIKR_KIDS_PRODUCT;
  }
  return null;
}
