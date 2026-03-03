export class FormFieldCategory {
  private _id: string;
  private _name: string;

  constructor(id: string | number, name: string) {
    this._id = String(id);
    this._name = name;
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  toJSON() {
    return {
      id: this._id,
      name: this._name,
    };
  }
}
